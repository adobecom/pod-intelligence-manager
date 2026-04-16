import type { Command } from "commander";
import fs from "node:fs";
import path from "node:path";
import chalk from "chalk";
import { CouncilClient } from "@council/sdk";
import type { Scope } from "@council/shared";
import { getBaseUrl } from "../util.js";

const SCOPES = new Set(["frontend", "backend", "design", "qa", "infra", "pm"]);

function resolveSessionOpts(opts: {
  pod?: string;
  agent?: string;
  scope?: string;
}): { podId: string; agentId: string; scope: Scope } {
  const podId = opts.pod ?? process.env.COUNCIL_POD_ID;
  const agentId = opts.agent ?? process.env.COUNCIL_AGENT_ID;
  const scopeRaw = opts.scope ?? process.env.COUNCIL_SCOPE;

  if (!podId?.trim()) {
    console.error(chalk.red("  Missing pod id: set COUNCIL_POD_ID or use --pod"));
    process.exit(1);
  }
  if (!agentId?.trim()) {
    console.error(chalk.red("  Missing agent id: set COUNCIL_AGENT_ID or use --agent"));
    process.exit(1);
  }
  if (!scopeRaw?.trim()) {
    console.error(chalk.red("  Missing scope: set COUNCIL_SCOPE or use --scope (frontend|backend|design|qa|infra|pm)"));
    process.exit(1);
  }
  if (!SCOPES.has(scopeRaw)) {
    console.error(chalk.red(`  Invalid scope "${scopeRaw}". Must be one of: ${[...SCOPES].join(", ")}`));
    process.exit(1);
  }

  return { podId, agentId, scope: scopeRaw as Scope };
}

function formatMarkdownBundle(ctx: Awaited<ReturnType<CouncilClient["pullSessionContext"]>>): string {
  const lines: string[] = [];
  lines.push(`# Council session context`);
  lines.push(`Pulled at: ${ctx.pulledAt}`);
  lines.push("");
  lines.push(`## Pod: ${ctx.pod.name} (${ctx.pod.pod_id})`);
  lines.push(`Pressure: ${ctx.pod.conflict_pressure} | Day ${ctx.pod.day_number}/${ctx.pod.total_days}`);
  lines.push("");
  lines.push(`## Living doc`);
  lines.push(ctx.livingDocMarkdown);
  lines.push("");
  lines.push(`## Open conflicts (${ctx.conflicts.filter((c) => c.status !== "resolved").length})`);
  for (const c of ctx.conflicts.filter((x) => x.status !== "resolved")) {
    lines.push(`- [${c.severity}] ${c.id}: ${c.summary}`);
  }
  if (ctx.conflicts.filter((c) => c.status !== "resolved").length === 0) {
    lines.push("- None");
  }
  lines.push("");
  lines.push(`## Relevant org learnings (${ctx.relevantLearnings.nodes.length}${ctx.relevantLearnings.truncated ? ", truncated" : ""})`);
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

export function registerContextCommand(program: Command) {
  program
    .command("context")
    .description("Pull bundled session context (living doc, pod, conflicts, learnings, recent updates)")
    .option("-p, --pod <podId>", "Pod ID (else COUNCIL_POD_ID)")
    .option("-a, --agent <id>", "Agent id (else COUNCIL_AGENT_ID)")
    .option("--scope <scope>", "Scope (else COUNCIL_SCOPE)")
    .option("--json", "Print JSON instead of markdown")
    .option("-w, --write <file>", "Also write markdown bundle to a file (e.g. .council/last-context.md)")
    .option("--learnings-tokens <n>", "Token budget for relevant learnings", "2000")
    .option("--recent <n>", "Max recent context updates to include", "20")
    .action(async (opts) => {
      const base = getBaseUrl(program);
      const { podId, agentId, scope } = resolveSessionOpts(opts);
      const learningsMaxTokens = parseInt(opts.learningsTokens, 10);
      const recentLimit = parseInt(opts.recent, 10);

      const client = new CouncilClient({
        baseUrl: base,
        podId,
        agentId,
        scope,
      });

      const ctx = await client.pullSessionContext({
        learningsMaxTokens: Number.isFinite(learningsMaxTokens) ? learningsMaxTokens : 2000,
        recentUpdateLimit: Number.isFinite(recentLimit) ? recentLimit : 20,
      });

      if (opts.json) {
        console.log(JSON.stringify(ctx, null, 2));
      } else {
        console.log(formatMarkdownBundle(ctx));
      }

      if (opts.write) {
        const outPath = path.resolve(opts.write);
        fs.mkdirSync(path.dirname(outPath), { recursive: true });
        fs.writeFileSync(outPath, formatMarkdownBundle(ctx), "utf-8");
        console.error(chalk.dim(`\n  Wrote ${outPath}\n`));
      }
    });
}
