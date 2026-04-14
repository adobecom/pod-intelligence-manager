import type { Command } from "commander";
import chalk from "chalk";

export function getBaseUrl(program: Command): string {
  return program.opts().server as string;
}

export async function fetchJSON<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) {
    const body = await res.text();
    console.error(chalk.red(`\n  Error: ${res.status} — ${body}\n`));
    process.exit(1);
  }
  return res.json() as Promise<T>;
}
