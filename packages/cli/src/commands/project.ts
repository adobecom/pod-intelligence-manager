import type { Command } from "commander";
import chalk from "chalk";
import type { Project, ProjectResources } from "@pim/shared";
import { getBaseUrl, fetchJSON } from "../util.js";

function parseList(raw: string | undefined): string[] | undefined {
  if (!raw) return undefined;
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function buildResources(opts: {
  jira?: string;
  jiraTeam?: string;
  repos?: string;
  slack?: string;
  spaces?: string;
  gitPaths?: string;
  alias?: string;
}): ProjectResources | undefined {
  const resources: ProjectResources = {};
  const jira = parseList(opts.jira);
  const team = opts.jiraTeam?.trim() || undefined;
  const repos = parseList(opts.repos);
  const slack = parseList(opts.slack);
  const spaces = parseList(opts.spaces);
  const gitPaths = parseList(opts.gitPaths);
  const aliases = parseList(opts.alias);
  if (jira || team) {
    resources.jira = {
      ...(jira ? { project_keys: jira } : {}),
      ...(team ? { team } : {}),
    };
  }
  if (repos) resources.github = { repos };
  if (slack) resources.slack = { channels: slack };
  if (spaces) resources.confluence = { space_keys: spaces };
  if (gitPaths) resources.git = { repo_paths: gitPaths };
  if (aliases) resources.aliases = aliases;
  return Object.keys(resources).length > 0 ? resources : undefined;
}

function printResources(resources: ProjectResources | undefined) {
  if (!resources || Object.keys(resources).length === 0) {
    console.log(chalk.dim("  (no resources configured)"));
    return;
  }
  if (resources.jira?.project_keys?.length)
    console.log(`  Jira keys:        ${resources.jira.project_keys.join(", ")}`);
  if (resources.jira?.team)
    console.log(`  Jira team:        ${resources.jira.team}`);
  if (resources.github?.repos?.length)
    console.log(`  GitHub repos:     ${resources.github.repos.join(", ")}`);
  if (resources.slack?.channels?.length)
    console.log(`  Slack channels:   ${resources.slack.channels.join(", ")}`);
  if (resources.confluence?.space_keys?.length)
    console.log(`  Confluence:       ${resources.confluence.space_keys.join(", ")}`);
  if (resources.git?.repo_paths?.length)
    console.log(`  Git repo paths:   ${resources.git.repo_paths.join(", ")}`);
  if (resources.aliases?.length)
    console.log(`  Aliases:          ${resources.aliases.join(", ")}`);
}

export function registerProjectCommands(program: Command) {
  const project = program.command("project").description("Manage projects");

  project
    .command("create")
    .description("Create a new project with optional onboarded resources")
    .argument("<name>", "Project name")
    .option("--description <text>")
    .option("--jira <keys>", "Comma-separated Jira project keys (e.g. ADPINTAKE,T3EV)")
    .option("--jira-team <team>", "Jira Team field value (e.g. 'Strata') — maps to the `Team` custom field")
    .option("--repos <repos>", "Comma-separated GitHub repos (org/name,org2/name2)")
    .option("--slack <channels>", "Comma-separated Slack channel names")
    .option("--spaces <keys>", "Comma-separated Confluence space keys")
    .option("--git-paths <paths>", "Comma-separated absolute paths to local git clones")
    .option("--alias <aliases>", "Comma-separated aliases/synonyms for the project")
    .action(async (name: string, opts) => {
      const base = getBaseUrl(program);
      const resources = buildResources(opts);
      const created = await fetchJSON<Project>(`${base}/api/projects`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          description: opts.description,
          resources,
        }),
      });
      console.log(chalk.green("\n  Project created.\n"));
      console.log(`  ID:    ${chalk.bold(created.project_id)}`);
      console.log(`  Name:  ${created.name}`);
      console.log();
      printResources(created.resources);
      console.log();
    });

  project
    .command("list")
    .description("List all projects")
    .action(async () => {
      const base = getBaseUrl(program);
      const projects = await fetchJSON<Project[]>(`${base}/api/projects`);
      if (projects.length === 0) {
        console.log(chalk.yellow("\n  No projects.\n"));
        return;
      }
      console.log(chalk.bold("\n  Projects\n"));
      for (const p of projects) {
        console.log(`  ${chalk.bold(p.name)}  ${chalk.dim(`(${p.project_id})`)}`);
      }
      console.log();
    });

  project
    .command("show")
    .description("Show a project's configured resources")
    .argument("<projectId>", "Project ID")
    .action(async (projectId: string) => {
      const base = getBaseUrl(program);
      const p = await fetchJSON<Project>(`${base}/api/projects/${projectId}`);
      console.log(chalk.bold(`\n  ${p.name}`));
      console.log(chalk.dim("  " + "-".repeat(50)));
      console.log(`  ID:          ${p.project_id}`);
      if (p.description) console.log(`  Description: ${p.description}`);
      console.log();
      printResources(p.resources);
      console.log();
    });

  project
    .command("set-resources")
    .description("Replace a project's external resources (Jira, GitHub, Slack, Confluence, git paths, aliases)")
    .argument("<projectId>", "Project ID")
    .option("--jira <keys>")
    .option("--jira-team <team>")
    .option("--repos <repos>")
    .option("--slack <channels>")
    .option("--spaces <keys>")
    .option("--git-paths <paths>")
    .option("--alias <aliases>")
    .action(async (projectId: string, opts) => {
      const base = getBaseUrl(program);
      const resources = buildResources(opts) ?? {};
      const updated = await fetchJSON<ProjectResources>(
        `${base}/api/projects/${projectId}/resources`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(resources),
        },
      );
      console.log(chalk.green("\n  Resources updated.\n"));
      printResources(updated);
      console.log();
    });
}
