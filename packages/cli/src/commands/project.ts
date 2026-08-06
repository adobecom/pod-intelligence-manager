import type { Command } from "commander";
import chalk from "chalk";
import { PROJECT_SEARCH_SOURCES, type Project, type ProjectResources, type ProjectSearchResponse, type ProjectSearchIndexStats } from "@pim/shared";
import { getBaseUrl, fetchJSON } from "../util.js";

type ProjectSearchAnswerCitationView = {
  ref: string;
  source: string;
  title: string;
  url?: string;
};

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
    .description("Create a new project with optional onboarded resources (resources require org admin)")
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
    .description("Replace a project's external resources (org admin only)")
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

  project
    .command("search")
    .description("Search a project's indexed artifacts (hybrid lexical + semantic)")
    .argument("<projectId>", "Project ID")
    .argument("<query...>", "Search query or exact identifier (Jira key, PR #, file path)")
    .option("--sources <list>", "Comma-separated sources (jira,github,confluence,slack,git,project_update,pod_update,kg)")
    .option("--entity-types <list>", "Comma-separated entity types (ticket,pr,commit,file,symbol,person,doc,feature,decision,risk,blocker)")
    .option("--days <n>", "Only artifacts updated within this many days", (v) => parseInt(v, 10))
    .option("--max <n>", "Max hits to return", (v) => parseInt(v, 10))
    .option("--mind-map", "Include an entity/edge mind-map neighborhood")
    .option("--answer", "Include a plain-language synthesized answer over the hits")
    .option("--no-graph", "Disable bounded graph expansion")
    .option("--no-kg", "Skip the project-scoped KG overlay")
    .option("--live", "Allow the separately gated live fallback when the index has no candidates")
    .option("--json", "Print the raw JSON response")
    .action(async (projectId: string, queryParts: string[], opts) => {
      const base = getBaseUrl(program);
      const query = queryParts.join(" ");
      const body: Record<string, unknown> = { query };
      const sources = parseList(opts.sources);
      if (sources) body.sources = sources;
      const entityTypes = parseList(opts.entityTypes);
      if (entityTypes) body.entity_types = entityTypes;
      if (opts.days) body.time_window_days = opts.days;
      if (opts.max) body.max_hits = opts.max;
      if (opts.mindMap) body.include_mind_map = true;
      if (opts.answer) body.synthesize = true;
      if (opts.graph === false) body.graph_expansion = false;
      if (opts.kg === false) body.include_kg = false;
      if (opts.live) body.use_live = true;

      const res = await fetchJSON<ProjectSearchResponse>(`${base}/api/projects/${projectId}/search`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (opts.json) {
        console.log(JSON.stringify(res, null, 2));
        return;
      }

      console.log(
        chalk.dim(
          `\n  ${res.hits.length} hit(s) · ${res.retrieval_mode} · sources: ${res.sources_used.join(", ") || "none"} · embedding coverage ${(res.embedding_coverage * 100).toFixed(0)}%`,
        ),
      );
      if (res.detected_identifiers.length > 0) {
        console.log(chalk.dim(`  identifiers: ${res.detected_identifiers.join(", ")}`));
      }
      const coverage = PROJECT_SEARCH_SOURCES
        .map((s) => `${s}:${res.documents_by_source[s] ?? 0}`)
        .join(" ");
      console.log(chalk.dim(`  coverage: ${coverage}`));
      console.log();
      if (res.summary_md) {
        const answerCitations = (res as ProjectSearchResponse & {
          answer_citations?: ProjectSearchAnswerCitationView[];
        }).answer_citations;
        console.log(chalk.bold("  Answer\n"));
        console.log(res.summary_md.split("\n").map((l) => `  ${l}`).join("\n"));
        if (answerCitations?.length) {
          console.log(chalk.bold("\n  Answer evidence\n"));
          for (const c of answerCitations.slice(0, 8)) {
            console.log(`  ${chalk.bold(`[${c.ref}]`)} ${chalk.dim(c.source)} — ${c.title}`);
            if (c.url) console.log(`      ${chalk.blue(c.url)}`);
          }
        }
        console.log(chalk.dim("\n  ── sources ──"));
      }
      if (res.hits.length === 0) {
        console.log(chalk.yellow("  No matching project artifacts.\n"));
      }
      res.hits.forEach((h, i) => {
        const when = h.occurred_at ? chalk.dim(` (${h.occurred_at.slice(0, 10)})`) : "";
        const tags = [
          h.source,
          h.matched.identifier ? "exact" : null,
          h.matched.semantic ? "semantic" : null,
          h.matched.graph ? "graph" : null,
        ]
          .filter(Boolean)
          .join("/");
        console.log(`  ${chalk.bold(`[${i + 1}]`)} ${chalk.cyan(h.title)}${when}  ${chalk.dim(`{${tags}}`)}`);
        console.log(`      ${chalk.dim(h.snippet)}`);
        if (h.url) console.log(`      ${chalk.blue(h.url)}`);
      });
      if (res.kg_overlay?.length) {
        console.log(chalk.bold("\n  KG overlay"));
        for (const k of res.kg_overlay) console.log(`   • ${k.summary} ${chalk.dim(`(${k.type})`)}`);
      }
      if (res.mind_map) {
        console.log(
          chalk.dim(`\n  mind-map: ${res.mind_map.entities.length} entities, ${res.mind_map.edges.length} edges`),
        );
      }
      console.log();
    });

  project
    .command("reindex")
    .description("Start or rebuild a project's search index from its working memory (and optionally embed)")
    .argument("<projectId>", "Project ID")
    .option("--embed", "Generate chunk embeddings (requires Bedrock credentials; rate-limited)")
    .action(async (projectId: string, opts) => {
      const base = getBaseUrl(program);
      const stats = await fetchJSON<ProjectSearchIndexStats>(
        `${base}/api/projects/${projectId}/search/reindex`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ embed: !!opts.embed }),
        },
      );
      console.log(chalk.green("\n  Project indexing started; build complete.\n"));
      console.log(`  Documents: ${chalk.bold(stats.documents_indexed)}`);
      console.log(`  Chunks:    ${chalk.bold(stats.chunks_indexed)}`);
      console.log(`  Entities:  ${chalk.bold(stats.entities_indexed)}`);
      console.log(`  Edges:     ${chalk.bold(stats.edges_indexed)}`);
      console.log(
        `  Embedded:  ${chalk.bold(stats.chunks_embedded)} ${stats.embedding_available ? "" : chalk.dim("(embedding service unavailable)")}`,
      );
      console.log();
    });
}
