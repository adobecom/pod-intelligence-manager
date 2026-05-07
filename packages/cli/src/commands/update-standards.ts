import type { Command } from "commander";
import chalk from "chalk";
import { STANDARDS_CATALOGUE } from "../standards-catalogue.js";
import {
  readStandardsLock,
  writeStandardsLock,
  fetchLatestCommitSha,
  installSourceStandards,
} from "../shared-standards.js";
import { findGitRoot } from "../config.js";

export function registerUpdateStandardsCommand(program: Command): void {
  program
    .command("update-standards")
    .description("Check for and download updates to installed shared standards")
    .option("--force", "Re-download all standards even if already up to date")
    .option("--dry-run", "Report what would change without writing files")
    .action(async (opts) => {
      const root = findGitRoot();
      if (!root) {
        console.error(chalk.red("\n  Not a git repository. Run this from a git repo root.\n"));
        process.exit(1);
      }

      const lock = readStandardsLock(root);
      if (!lock?.sources.length) {
        console.log(chalk.yellow("\n  No standards lock found. Run `pim init` to install shared standards.\n"));
        return;
      }

      console.log(chalk.bold("\n  PIM Update Standards\n"));

      let updated = 0;
      let skipped = 0;
      let errored = 0;

      for (const lockedSource of lock.sources) {
        const source = STANDARDS_CATALOGUE.find(s => s.id === lockedSource.id);
        if (!source) {
          console.log(chalk.yellow(`  Unknown source "${lockedSource.id}" — skipped`));
          continue;
        }

        process.stdout.write(chalk.dim(`  Checking ${source.name}...`));
        let latestSha: string;
        try {
          latestSha = await fetchLatestCommitSha(source);
        } catch (e) {
          process.stdout.write("\n");
          console.log(chalk.yellow(`  Could not check ${source.name}: ${e instanceof Error ? e.message : e}`));
          errored++;
          continue;
        }

        const isUpToDate = latestSha === lockedSource.installedSha;
        if (!opts.force && isUpToDate) {
          process.stdout.write(chalk.green(" up to date\n"));
          skipped++;
          continue;
        }

        process.stdout.write(opts.dryRun ? chalk.cyan(" update available\n") : "\n");

        if (opts.dryRun) {
          console.log(chalk.dim(`    installed: ${lockedSource.installedSha.slice(0, 8)}`));
          console.log(chalk.dim(`    latest:    ${latestSha.slice(0, 8)}`));
          updated++;
          continue;
        }

        try {
          const itemFilter = lockedSource.installedItems.length ? lockedSource.installedItems : undefined;
          const result = await installSourceStandards(root, source, msg => console.log(msg), itemFilter);
          lockedSource.installedSha = result.sha;
          lockedSource.installedItems = result.installedItems;
          console.log(chalk.green(`  ✓ ${source.name} updated (${result.installedItems.length} items)`));
          updated++;
        } catch (e) {
          console.log(chalk.red(`  Failed to update ${source.name}: ${e instanceof Error ? e.message : e}`));
          errored++;
        }
      }

      if (!opts.dryRun) {
        const now = new Date().toISOString();
        lock.lastChecked = now;
        if (updated > 0) lock.updatedAt = now;
        writeStandardsLock(root, lock);
      }

      const label = opts.dryRun ? "would update" : "updated";
      if (updated === 0 && errored === 0) {
        console.log(chalk.green("\n  All standards up to date.\n"));
      } else {
        const parts = [`${updated} source(s) ${label}`, `${skipped} up to date`];
        if (errored > 0) parts.push(`${errored} errored`);
        console.log(chalk.bold(`\n  ${parts.join(", ")}.\n`));
      }
    });
}
