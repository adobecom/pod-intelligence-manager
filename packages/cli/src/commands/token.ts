import type { Command } from "commander";
import chalk from "chalk";
import { fetchJSON, getBaseUrl, setOrgSlug } from "../util.js";

interface ServiceTokenItem {
  token_id: string;
  name: string;
  token_prefix: string;
  scopes: string[];
  project_id: string | null;
  pod_id: string | null;
  expires_at: string;
  revoked_at: string | null;
  last_used_at: string | null;
  created_at: string;
}

interface CreatedServiceToken extends ServiceTokenItem {
  token: string;
}

function collect(value: string, previous: string[]): string[] {
  previous.push(value);
  return previous;
}

function parseExpires(raw: string): number {
  const value = raw.trim();
  const match = value.match(/^(\d+)(d)?$/);
  if (!match) {
    console.error(chalk.red("  --expires must be a day duration such as 30d or 90d"));
    process.exit(1);
  }
  const days = Number(match[1]);
  if (!Number.isSafeInteger(days) || days <= 0 || days > 365) {
    console.error(chalk.red("  --expires must be between 1d and 365d"));
    process.exit(1);
  }
  return days;
}

function applyOrg(opts: { org?: string }): void {
  if (opts.org?.trim()) setOrgSlug(opts.org.trim());
}

function printToken(token: ServiceTokenItem): void {
  const binding = token.project_id
    ? `project:${token.project_id}`
    : token.pod_id
      ? `pod:${token.pod_id}`
      : "org";
  const revoked = token.revoked_at ? chalk.red("revoked") : chalk.green("active");
  console.log(`  ${chalk.bold(token.token_id)}  ${token.name}`);
  console.log(`    ${revoked}  ${binding}  expires ${token.expires_at}`);
  console.log(`    scopes: ${token.scopes.join(", ")}`);
  console.log(`    prefix: ${token.token_prefix}`);
  if (token.last_used_at) console.log(`    last used: ${token.last_used_at}`);
}

export function registerTokenCommands(program: Command): void {
  const token = program.command("token").description("Manage PIM service tokens");

  token
    .command("create")
    .description("Create a scoped PIM service token")
    .requiredOption("--org <slug>", "Org slug")
    .requiredOption("--name <name>", "Service token name")
    .option("--scope <scope>", "Scope to grant; repeatable", collect, [] as string[])
    .option("--project <projectId>", "Restrict token to one project")
    .option("--pod <podId>", "Restrict token to one pod")
    .option("--expires <duration>", "Expiration in days, e.g. 90d", "90d")
    .action(async (opts) => {
      applyOrg(opts);
      if (opts.scope.length === 0) {
        console.error(chalk.red("  At least one --scope is required"));
        process.exit(1);
      }
      if (opts.project && opts.pod) {
        console.error(chalk.red("  Use either --project or --pod, not both"));
        process.exit(1);
      }
      const base = getBaseUrl(program);
      const created = await fetchJSON<CreatedServiceToken>(`${base}/api/org/service-tokens`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: opts.name,
          scopes: opts.scope,
          project_id: opts.project,
          pod_id: opts.pod,
          expires_in_days: parseExpires(opts.expires),
        }),
      });

      console.log(chalk.green("\n  Service token created.\n"));
      printToken(created);
      console.log(chalk.bold("\n  Token"));
      console.log(`  ${created.token}\n`);
    });

  token
    .command("list")
    .description("List service tokens for an org")
    .requiredOption("--org <slug>", "Org slug")
    .action(async (opts) => {
      applyOrg(opts);
      const base = getBaseUrl(program);
      const body = await fetchJSON<{ tokens: ServiceTokenItem[] }>(`${base}/api/org/service-tokens`);
      if (body.tokens.length === 0) {
        console.log(chalk.yellow("\n  No service tokens.\n"));
        return;
      }
      console.log(chalk.bold("\n  Service tokens\n"));
      for (const item of body.tokens) {
        printToken(item);
        console.log();
      }
    });

  token
    .command("revoke")
    .description("Revoke a service token")
    .requiredOption("--org <slug>", "Org slug")
    .requiredOption("--token <tokenId>", "Token id, e.g. svctok...")
    .action(async (opts) => {
      applyOrg(opts);
      const base = getBaseUrl(program);
      await fetchJSON<{ ok: true }>(`${base}/api/org/service-tokens/${encodeURIComponent(opts.token)}/revoke`, {
        method: "POST",
      });
      console.log(chalk.green(`\n  Service token revoked: ${opts.token}\n`));
    });
}
