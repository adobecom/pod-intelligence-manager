import fs from "node:fs";
import path from "node:path";
import type { Command } from "commander";
import chalk from "chalk";
import { checkbox, confirm, input, select } from "@inquirer/prompts";
import type { OrgConfig } from "@pim/shared";
import { getBaseUrl, apiFetch, setOrgSlug } from "../util.js";
import { findGitRoot, getGitUserName } from "../config.js";
import { loadCredentials } from "@pim/shared/auth";
import { installHooks, resolveRunnerPath } from "./hooks.js";
import {
  renderPodAgentProtocol,
  PROTOCOL_MARKER_BEGIN,
  PROTOCOL_MARKER_END,
} from "../templates/pod-agent-protocol.md.js";
import { renderSyncCommand } from "../templates/sync-command.md.js";
import {
  buildWizardStandardsChoices,
  checkForUpdates,
  installSelectedSources,
} from "../shared-standards.js";
import {
  defaultScopeIdFromConfig,
  fetchOrgConfig,
  fetchOrgPods,
  fetchProjects,
  fetchUserOrgs,
  formatScopeChoicesForError,
  scopeIdsFromConfig,
  verifyProjectExists,
  type UserOrgSummary,
} from "../org-config.js";

export interface RunInitOptions {
  serverUrl: string;
  root: string;
  podId?: string;
  projectId?: string;
  orgSlug: string;
  scope?: string;
  agentId?: string;
  /** Used in templates when scope is omitted (first org scope). */
  defaultScopeId: string;
  skipHooks: boolean;
  skipClaude: boolean;
  skipClaudeMd: boolean;
  selectedSources?: string[];
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
    orgSlug,
    scope,
    agentId,
    defaultScopeId,
    skipHooks,
    skipClaude,
    skipClaudeMd,
    selectedSources,
  } = opts;

  const templateScope = scope ?? defaultScopeId;

  // 3. Write .pim.json
  const configPath = path.join(root, ".pim.json");
  const configData: Record<string, unknown> = {
    orgSlug,
    serverUrl,
    autoReport: { gitHook: true, claudeCodeHook: true },
  };
  if (podId) configData.podId = podId;
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

    type HookRecord = Record<string, unknown>;
    const postHooks = (hooks.PostToolUse ?? hooks.PostToolCall ?? []) as HookRecord[];
    const hasPostHook = postHooks.some((h) => {
      const nested = h.hooks as Array<{ command: string }> | undefined;
      return nested?.[0]?.command?.includes("claude-code-post-tool") || (h.command as string)?.includes("claude-code-post-tool");
    });
    if (!hasPostHook) {
      postHooks.push({
        matcher: "Bash",
        hooks: [{ type: "command", command: `node ${JSON.stringify(postToolScript)}` }],
      });
    }
    hooks.PostToolUse = postHooks;
    delete hooks.PostToolCall;

    const preHooks = (hooks.PreToolUse ?? hooks.PreToolCall ?? []) as HookRecord[];
    const hasPreHook = preHooks.some((h) => {
      const nested = h.hooks as Array<{ command: string }> | undefined;
      return nested?.[0]?.command?.includes("claude-code-pre-tool") || (h.command as string)?.includes("claude-code-pre-tool");
    });
    if (!hasPreHook) {
      preHooks.push({
        matcher: "Bash",
        hooks: [{ type: "command", command: `node ${JSON.stringify(preToolScript)}` }],
      });
    }
    hooks.PreToolUse = preHooks;
    delete hooks.PreToolCall;

    settings.hooks = hooks;
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n", "utf-8");
    console.log(chalk.green("  Updated .claude/settings.json (hooks)"));

    const commandsDir = path.join(claudeDir, "commands");
    fs.mkdirSync(commandsDir, { recursive: true });
    const syncPath = path.join(commandsDir, "sync.md");
    fs.writeFileSync(syncPath, renderSyncCommand({ podId, projectId: projectIdOpt, scope: templateScope }), "utf-8");
    console.log(chalk.green("  Created .claude/commands/sync.md"));
  } else {
    console.log(chalk.dim("  Skipped Claude Code integration (--skip-claude)"));
  }

  // 6. CLAUDE.md addendum
  if (!skipClaudeMd) {
    const claudeMdPath = path.join(root, "CLAUDE.md");
    const protocol = renderPodAgentProtocol({
      podId,
      projectId: projectIdOpt,
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

  // 8. Install shared standards skills
  if (selectedSources?.length) {
    console.log(chalk.dim("\n  Installing shared standards..."));
    await installSelectedSources(root, selectedSources);
  }

  console.log(chalk.bold.green("\n  PIM initialized!\n"));
  console.log(chalk.dim("  Next steps:"));
  console.log(chalk.dim(`    1. Set PIM_AGENT_ID (or pass --agent) for commit attribution`));
  if (!scope) {
    console.log(chalk.dim(`    2. Set PIM_SCOPE or pass --scope to scope your reports`));
  }
  if (podId) {
    console.log(chalk.dim(`    3. Run 'pim context --pod ${podId}' to pull initial pod state`));
  } else if (projectIdOpt) {
    console.log(chalk.dim(`    3. Run 'pim report --project ${projectIdOpt}' to submit your first update`));
  } else {
    console.log(chalk.dim(`    3. Run 'pim init --pod <podId>' or 'pim init --project <projectId>' to link a context target`));
  }
  console.log(chalk.dim(`    4. Start coding — commits will auto-report to PIM\n`));
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function runWizard(
  serverUrl: string,
  orgConfig: OrgConfig,
  root: string,
  initial: { project?: string; scope?: string; agent?: string },
): Promise<{ podId?: string; projectId?: string; scope?: string; agentId?: string; selectedSources: string[] }> {
  // Pod selection — optional; user can skip to project-only mode
  const pods = await fetchOrgPods(serverUrl);
  let podId: string | undefined;

  if (pods.length === 0) {
    console.log(chalk.yellow("  No active pods found. You can still link a long-lived project below."));
  } else {
    const SKIP = "__skip__";
    const podChoices = [
      ...pods.map(p => ({ name: `${p.name} (${p.pod_id})`, value: p.pod_id })),
      { name: chalk.dim("─────────────────────────────────"), value: SKIP, disabled: true },
      { name: "Skip — use project-level context only", value: SKIP },
    ];
    const picked = await select({
      message: "Which pod should this repo use?",
      choices: podChoices,
    });
    podId = picked === SKIP ? undefined : picked;
  }

  // Project selection — required if pod was skipped, optional otherwise
  let projectId = initial.project;
  if (projectId === undefined) {
    const projects = await fetchProjects(serverUrl);
    if (projects.length === 0 && !podId) {
      console.log(chalk.yellow("  No projects on the server either. Continuing without a context target."));
      console.log(chalk.dim("  Tip: create a project in the UI to give your commits long-term memory in PIM."));
    } else if (projects.length > 0) {
      const projectChoices = [
        ...projects.map(pr => ({ name: `${pr.name} (${pr.project_id})`, value: pr.project_id })),
        { name: podId ? "(none — pod context only)" : "(none)", value: "__none__" },
      ];
      const label = podId
        ? "Link a long-lived project for cross-sprint memory (optional)?"
        : "Which project should this repo report to?";
      const picked = await select({
        message: label,
        choices: projectChoices,
        default: podId ? "__none__" : projects[0].project_id,
      });
      projectId = picked === "__none__" ? undefined : picked;
    }
  }

  if (!podId && !projectId) {
    console.log(chalk.yellow("\n  No pod or project selected."));
    console.log(chalk.dim("  Hooks will be installed, but commits won't report anywhere until you"));
    console.log(chalk.dim("  run `pim init --pod <podId>` or `pim init --project <projectId>`.\n"));
  }

  // Scope — shown as a direct selector with a skip option so its purpose is clear
  let scope = initial.scope;
  if (scope === undefined) {
    const scopeChoices = [
      ...orgConfig.scopes.map(s => ({ name: `${s.label} — tags your reports to the ${s.label.toLowerCase()} workstream`, value: s.id })),
      { name: "(skip — set later with PIM_SCOPE env var)", value: "__none__" },
    ];
    const picked = await select({
      message: "Default scope for this repo (labels your auto-reports by team area):",
      choices: scopeChoices,
    });
    scope = picked === "__none__" ? undefined : picked;
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

  // Shared Standards — fetch catalogue and let user pick which sources to install
  let selectedSources: string[] = [];
  console.log(chalk.dim("  Fetching shared standards catalogue..."));
  let standardsChoices: Array<{ name: string; value: string; checked: boolean }> = [];
  try {
    standardsChoices = await buildWizardStandardsChoices();
  } catch {
    console.log(chalk.yellow("  Could not reach standards catalogue — skipping shared standards."));
  }
  if (standardsChoices.length > 0) {
    selectedSources = await checkbox({
      message: "Shared standards to install (.claude/skills/):",
      choices: standardsChoices,
    });
  }

  const target = podId
    ? `pod ${podId}${projectId ? `, project ${projectId}` : ""}`
    : projectId
      ? `project ${projectId}`
      : "no context target";
  const ok = await confirm({
    message: `Write .pim.json (${target})?`,
    default: true,
  });
  if (!ok) {
    console.log(chalk.dim("\n  Aborted.\n"));
    process.exit(0);
  }

  return { podId, projectId, scope, agentId, selectedSources };
}

export function registerInitCommand(program: Command): void {
  program
    .command("init")
    .description("Initialize PIM integration for this repo (hooks, Claude Code config, CLAUDE.md)")
    .option("-p, --pod <podId>", "Pod ID to connect to")
    .option("--org <slug>", "Org slug to bind this repo to (else picked interactively)")
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

      // Auto-check for stale skills on re-run
      try {
        const updateStatus = await checkForUpdates(root);
        if (!updateStatus.upToDate) {
          console.log(chalk.yellow(`  Skills may be outdated: ${updateStatus.staleSources.join(", ")}`));
          console.log(chalk.dim("  Run `pim update-standards` after init to update.\n"));
        }
      } catch {
        // Don't block init for update check failures
      }

      console.log(chalk.dim("  Checking server..."));
      let authMode: "trust" | "ims" | undefined;
      try {
        const healthRes = await apiFetch(`${serverUrl}/api/health`, { signal: AbortSignal.timeout(5000) });
        if (!healthRes.ok) throw new Error(`HTTP ${healthRes.status}`);
        const health = (await healthRes.json()) as { auth_mode?: "trust" | "ims" };
        authMode = health.auth_mode;
      } catch (e) {
        console.error(chalk.red(`  Cannot reach PIM server at ${serverUrl}`));
        console.error(chalk.dim(`  Make sure the server is running. Error: ${e instanceof Error ? e.message : e}\n`));
        process.exit(1);
      }
      console.log(chalk.green("  Server OK"));

      if (authMode === "ims" && !loadCredentials()) {
        console.error(chalk.red("\n  Not authenticated. Run `pim login` first.\n"));
        process.exit(1);
      }

      // Resolve org (GET /api/orgs is org-context-bypass, so no header needed here).
      let orgs: UserOrgSummary[];
      try {
        orgs = await fetchUserOrgs(serverUrl);
      } catch (e) {
        console.error(chalk.red("  Cannot list orgs."));
        console.error(chalk.dim(`  ${e instanceof Error ? e.message : e}\n`));
        process.exit(1);
      }

      if (orgs.length === 0) {
        console.error(chalk.red("\n  You are not a member of any org."));
        console.error(chalk.dim("  Create one in the UI first, or ask a teammate to invite you.\n"));
        process.exit(1);
      }

      let orgSlug: string;
      if (opts.org) {
        const match = orgs.find(o => o.slug === opts.org);
        if (!match) {
          console.error(
            chalk.red(`\n  You are not a member of org "${opts.org}". Available: ${orgs.map(o => o.slug).join(", ")}\n`),
          );
          process.exit(1);
        }
        orgSlug = match.slug;
      } else if (orgs.length === 1) {
        orgSlug = orgs[0].slug;
        console.log(chalk.green(`  Org: ${orgs[0].name} (${orgSlug})`));
      } else if (interactive) {
        orgSlug = await select({
          message: "Which org should this repo use?",
          choices: orgs.map(o => ({ name: `${o.name} (${o.slug}) — ${o.role}`, value: o.slug })),
        });
      } else {
        console.error(chalk.red("\n  Multiple orgs available — pass --org <slug> in non-interactive mode.\n"));
        process.exit(1);
      }

      // Pin the selected org for all subsequent requests in this process.
      setOrgSlug(orgSlug);

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
      let selectedSources: string[] = [];

      if (interactive && !opts.pod) {
        const w = await runWizard(serverUrl, orgConfig, root, {
          project: projectIdOpt,
          scope,
          agent: agentId,
        });
        podId = w.podId;
        projectIdOpt = w.projectId;
        scope = w.scope;
        agentId = w.agentId;
        selectedSources = w.selectedSources;
      } else {
        if (!podId?.trim() && !projectIdOpt?.trim()) {
          console.error(chalk.red("\n  Missing --pod or --project (at least one required in non-interactive mode / CI).\n"));
          process.exit(1);
        }
      }

      if (scope && !allowedIds.has(scope)) {
        console.error(
          chalk.red(`\n  Invalid scope "${scope}". Must be one of: ${formatScopeChoicesForError(orgConfig)}\n`),
        );
        process.exit(1);
      }

      if (podId) {
        console.log(chalk.dim("  Verifying pod..."));
        try {
          const podRes = await apiFetch(`${serverUrl}/api/pods/${encodeURIComponent(podId)}`, {
            signal: AbortSignal.timeout(5000),
          });
          if (!podRes.ok) throw new Error(`HTTP ${podRes.status}`);
          const pod = (await podRes.json()) as { name: string };
          console.log(chalk.green(`  Pod: ${pod.name} (${podId})`));
        } catch {
          console.error(chalk.red(`  Pod "${podId}" not found on server.\n`));
          process.exit(1);
        }
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
        podId,
        projectId: projectIdOpt,
        orgSlug,
        scope,
        agentId,
        defaultScopeId,
        skipHooks: !!opts.skipHooks,
        skipClaude: !!opts.skipClaude,
        skipClaudeMd: !!opts.skipClaudeMd,
        selectedSources,
      });
    });
}
