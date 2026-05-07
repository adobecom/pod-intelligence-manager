import fs from "node:fs";
import path from "node:path";
import type { Command } from "commander";
import chalk from "chalk";
import { PimClient } from "@pim/sdk";
import type { SessionContext } from "@pim/sdk";
import type { Scope } from "@pim/shared";
import { getBaseUrl, getOrgSlug, getAuthToken } from "../util.js";
import { findGitRoot } from "../config.js";
import { fetchOrgConfig, formatScopeChoicesForError, scopeIdsFromConfig } from "../org-config.js";

function resolveSessionOpts(
  opts: Record<string, string | undefined>,
  allowedScopeIds: Set<string>,
  scopeHelp: string,
) {
  const podId = opts.pod ?? process.env.PIM_POD_ID;
  const agentId = opts.agent ?? process.env.PIM_AGENT_ID;
  const scopeRaw = opts.scope ?? process.env.PIM_SCOPE;

  if (!podId?.trim()) {
    console.error(chalk.red("  Missing pod id: set PIM_POD_ID or use --pod"));
    process.exit(1);
  }
  if (!agentId?.trim()) {
    console.error(chalk.red("  Missing agent id: set PIM_AGENT_ID or use --agent"));
    process.exit(1);
  }
  if (!scopeRaw?.trim()) {
    console.error(chalk.red(`  Missing scope: set PIM_SCOPE or use --scope (${scopeHelp})`));
    process.exit(1);
  }
  if (!allowedScopeIds.has(scopeRaw)) {
    console.error(chalk.red(`  Invalid scope "${scopeRaw}". Must be one of: ${scopeHelp}`));
    process.exit(1);
  }

  return { podId, agentId, scope: scopeRaw as Scope };
}

function formatMarkdownBundle(ctx: SessionContext): string {
  const lines: string[] = [];

  lines.push(`# PIM session context`);
  lines.push(`Pulled at: ${ctx.pulledAt}`);
  lines.push("");

  lines.push(`## Pod: ${ctx.pod.name} (${ctx.pod.pod_id})`);
  lines.push(`Pressure: ${ctx.pod.conflict_pressure} | Day ${ctx.pod.day_number}/${ctx.pod.total_days}`);
  lines.push("");

  lines.push(`## Living doc`);
  lines.push(ctx.livingDocMarkdown);
  lines.push("");

  const openConflicts = ctx.conflicts.filter((c) => c.status !== "resolved");
  lines.push(`## Open conflicts (${openConflicts.length})`);
  for (const c of openConflicts) {
    lines.push(`- [${c.severity}] ${c.id}: ${c.summary}`);
  }
  if (openConflicts.length === 0) {
    lines.push("- None");
  }
  lines.push("");

  lines.push(
    `## Relevant org learnings (${ctx.relevantLearnings.nodes.length}${ctx.relevantLearnings.truncated ? ", truncated" : ""})`,
  );
  for (const n of ctx.relevantLearnings.nodes.slice(0, 12)) {
    lines.push(`- [${n.type}] ${n.summary}`);
  }
  if (ctx.relevantLearnings.nodes.length === 0) {
    lines.push("- None returned");
  }
  lines.push("");

  lines.push(`## Recent updates (${ctx.recentUpdates.length})`);
  for (const u of ctx.recentUpdates) {
    lines.push(`- [${u.timestamp}] ${u.agent_id} (${u.type}/${u.scope}): ${u.summary}`);
  }

  return lines.join("\n");
}

function formatBrief(ctx: SessionContext): string {
  const openConflicts = ctx.conflicts.filter((c) => c.status !== "resolved");
  const lines: string[] = [];

  lines.push(chalk.bold(`  Pod: ${ctx.pod.name} (${ctx.pod.pod_id})`));
  lines.push(`  Day ${ctx.pod.day_number}/${ctx.pod.total_days} | Pressure: ${ctx.pod.conflict_pressure}`);
  lines.push(`  Open conflicts: ${openConflicts.length}`);
  lines.push(`  Recent updates: ${ctx.recentUpdates.length}`);
  lines.push(`  Org learnings: ${ctx.relevantLearnings.nodes.length}`);
  lines.push("");

  if (openConflicts.length > 0) {
    lines.push(chalk.yellow("  Conflicts:"));
    for (const c of openConflicts.slice(0, 5)) {
      lines.push(`    [${c.severity}] ${c.summary}`);
    }
    lines.push("");
  }

  lines.push("  Latest updates:");
  for (const u of ctx.recentUpdates.slice(0, 5)) {
    lines.push(`    ${u.agent_id} (${u.type}): ${u.summary}`);
  }

  return lines.join("\n");
}

function writeFreshnessMarker(): void {
  const root = findGitRoot();
  if (!root) return;
  const dir = path.join(root, ".pim");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "last-pull"), new Date().toISOString(), "utf-8");
}

function diffWithLast(currentMd: string, lastPath: string): string | null {
  if (!fs.existsSync(lastPath)) return null;
  const prev = fs.readFileSync(lastPath, "utf-8");
  if (prev === currentMd) return "  No changes since last pull.";

  // Simple line-level diff summary
  const prevLines = new Set(prev.split("\n"));
  const currLines = currentMd.split("\n");
  const added = currLines.filter((l) => !prevLines.has(l) && l.trim().length > 0);

  if (added.length === 0) return "  Minor formatting changes only.";

  const lines = [chalk.bold("  Changes since last pull:"), ""];
  for (const line of added.slice(0, 20)) {
    lines.push(chalk.green(`  + ${line}`));
  }
  if (added.length > 20) {
    lines.push(chalk.dim(`  ... and ${added.length - 20} more lines`));
  }
  return lines.join("\n");
}

export function registerContextCommand(program: Command): void {
  program
    .command("context")
    .description("Pull bundled session context (living doc, pod, conflicts, learnings, recent updates)")
    .option("-p, --pod <podId>", "Pod ID (else PIM_POD_ID)")
    .option("-a, --agent <id>", "Agent id (else PIM_AGENT_ID)")
    .option("--scope <scope>", "Scope (else PIM_SCOPE)")
    .option("--json", "Print JSON instead of markdown")
    .option("--brief", "Print one-screen summary")
    .option("--diff", "Show only what changed since last pull")
    .option("-w, --write <file>", "Also write markdown bundle to a file (e.g. .pim/last-context.md)")
    .option("--learnings-tokens <n>", "Token budget for relevant learnings", "2000")
    .option("--recent <n>", "Max recent context updates to include", "20")
    .action(async (opts) => {
      const base = getBaseUrl(program);
      let orgConfig;
      try {
        orgConfig = await fetchOrgConfig(base);
      } catch (e) {
        console.error(chalk.red("\n  Cannot load org config from server."));
        console.error(chalk.dim(`  ${e instanceof Error ? e.message : e}\n`));
        process.exit(1);
      }
      const allowed = scopeIdsFromConfig(orgConfig);
      const scopeHelp = formatScopeChoicesForError(orgConfig);
      const { podId, agentId, scope } = resolveSessionOpts(opts, allowed, scopeHelp);

      const learningsMaxTokens = parseInt(opts.learningsTokens, 10);
      const recentLimit = parseInt(opts.recent, 10);

      const client = new PimClient({
        baseUrl: base,
        podId,
        agentId,
        scope,
        orgSlug: getOrgSlug() ?? undefined,
        authToken: getAuthToken() ?? undefined,
      });

      const ctx = await client.pullSessionContext({
        learningsMaxTokens: Number.isFinite(learningsMaxTokens) ? learningsMaxTokens : 2000,
        recentUpdateLimit: Number.isFinite(recentLimit) ? recentLimit : 20,
      });

      const md = formatMarkdownBundle(ctx);

      // Always write freshness marker
      writeFreshnessMarker();

      // Determine output path for last-context.md
      const root = findGitRoot();
      const lastContextPath = root ? path.join(root, ".pim", "last-context.md") : null;

      if (opts.diff && lastContextPath) {
        const diffOutput = diffWithLast(md, lastContextPath);
        if (diffOutput) {
          console.log(diffOutput);
        } else {
          console.log("  No previous context to diff against. Showing full context.\n");
          console.log(opts.brief ? formatBrief(ctx) : md);
        }
      } else if (opts.json) {
        console.log(JSON.stringify(ctx, null, 2));
      } else if (opts.brief) {
        console.log(formatBrief(ctx));
      } else {
        console.log(md);
      }

      // Always save last context for future diffs
      if (lastContextPath) {
        fs.mkdirSync(path.dirname(lastContextPath), { recursive: true });
        fs.writeFileSync(lastContextPath, md, "utf-8");
      }

      // Optional explicit write target
      if (opts.write) {
        const outPath = path.resolve(opts.write);
        fs.mkdirSync(path.dirname(outPath), { recursive: true });
        fs.writeFileSync(outPath, md, "utf-8");
        console.error(chalk.dim(`\n  Wrote ${outPath}\n`));
      }
    });
}
