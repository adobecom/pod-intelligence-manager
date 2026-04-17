import type { Command } from "commander";
import chalk from "chalk";
import { searchContext } from "@pim/sdk";
import type { ContextSearchHit, ContextSearchRequest, ContextSource } from "@pim/shared";
import { CONTEXT_SOURCES } from "@pim/shared";
import { getBaseUrl } from "../util.js";

function parseSources(raw?: string): ContextSource[] | undefined {
  if (!raw) return undefined;
  const parts = raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const valid = new Set<ContextSource>(CONTEXT_SOURCES);
  const result: ContextSource[] = [];
  for (const p of parts) {
    if (!valid.has(p as ContextSource)) {
      console.error(chalk.red(`  Unknown source "${p}". Valid: ${CONTEXT_SOURCES.join(", ")}`));
      process.exit(1);
    }
    result.push(p as ContextSource);
  }
  return result;
}

function sourceInitial(source: ContextSource): string {
  return { slack: "S", fluffyjaws: "F", jira: "J", confluence: "C", github: "G", git: "X" }[source];
}

function formatHit(hit: ContextSearchHit, index: number): string {
  const lines: string[] = [];
  const when = hit.timestamp ? ` — ${hit.timestamp.slice(0, 10)}` : "";
  const author = hit.author ? ` (${hit.author})` : "";
  lines.push(
    chalk.bold(`  [${sourceInitial(hit.source)}${index}] ${hit.source}`) +
      author +
      when,
  );
  lines.push(`       ${hit.title}`);
  if (hit.url) lines.push(chalk.dim(`       ${hit.url}`));
  if (hit.snippet) lines.push(chalk.dim(`       ${hit.snippet}`));
  return lines.join("\n");
}

export function registerSearchCommand(program: Command): void {
  program
    .command("search")
    .description(
      "Cross-source context search (Slack, Fluffyjaws, Jira, Confluence, GitHub, local git).",
    )
    .argument("<query...>", "Query text")
    .option(
      "--sources <csv>",
      `Restrict sources (comma-separated). Choices: ${CONTEXT_SOURCES.join(", ")}`,
    )
    .option("--pod <podId>", "Pod id — enables local git search for that pod's repo")
    .option("--days <n>", "Time window in days (default 90)", "90")
    .option("--max <n>", "Max hits per source (default 10)", "10")
    .option("--no-synthesize", "Skip LLM summarization; return raw hits only")
    .option("--no-cache", "Force a fresh fan-out, bypassing the cache")
    .option("--json", "Print the raw JSON response instead of formatted output")
    .option("--brief", "Print only the synthesized summary, no raw hits")
    .option("--raw", "Print only the raw hits, no summary")
    .action(async (queryParts: string[], opts) => {
      const base = getBaseUrl(program);
      const query = queryParts.join(" ").trim();
      if (!query) {
        console.error(chalk.red("  Empty query"));
        process.exit(1);
      }

      const request: ContextSearchRequest = {
        query,
        sources: parseSources(opts.sources),
        pod_id: opts.pod ?? process.env.PIM_POD_ID,
        time_window_days: Number.parseInt(opts.days, 10) || 90,
        max_hits_per_source: Number.parseInt(opts.max, 10) || 10,
        synthesize: opts.synthesize !== false,
        use_cache: opts.cache !== false,
      };

      const result = await searchContext(base, request);

      if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      if (!opts.raw && result.summary_md) {
        console.log(chalk.bold("\n  Summary\n"));
        console.log(indent(result.summary_md));
      } else if (!opts.raw && request.synthesize !== false) {
        console.log(chalk.dim("\n  (no summary — LLM unavailable or no hits)"));
      }

      if (!opts.brief) {
        console.log(chalk.bold(`\n  Hits (${result.hits.length})\n`));
        result.hits.forEach((h, i) => console.log(formatHit(h, i + 1)));
      }

      console.log(chalk.dim(`\n  Sources used: ${result.sources_used.join(", ") || "(none)"}`));
      if (result.missing_sources.length > 0) {
        console.log(chalk.dim(`  Missing:`));
        for (const m of result.missing_sources) {
          console.log(chalk.dim(`    ${m.source}: ${m.reason}`));
        }
      }
      console.log(
        chalk.dim(
          `  ${result.from_cache ? "cached" : "fresh"} — generated ${result.generated_at}\n`,
        ),
      );
    });
}

function indent(text: string): string {
  return text
    .split("\n")
    .map((l) => `  ${l}`)
    .join("\n");
}
