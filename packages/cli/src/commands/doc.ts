import type { Command } from "commander";
import chalk from "chalk";
import { getBaseUrl, apiFetch } from "../util.js";

export function registerDocCommand(program: Command) {
  program
    .command("doc")
    .description("Print the living doc for a pod")
    .argument("<podId>", "Pod ID")
    .action(async (podId: string) => {
      const base = getBaseUrl(program);

      const res = await apiFetch(`${base}/api/pods/${podId}/living-doc`);
      if (!res.ok) {
        console.error(chalk.red(`  Error: ${res.status} — ${await res.text()}`));
        process.exit(1);
      }
      const markdown = await res.text();
      console.log(markdown);
    });
}
