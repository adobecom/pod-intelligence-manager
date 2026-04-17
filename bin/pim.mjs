#!/usr/bin/env node
/**
 * Global `pim` entry when this repo is linked (`pnpm link --global`).
 * Runs the CLI from TypeScript source via the workspace tsx dependency.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const binDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(binDir, "..");
/** Shell cwd when the user invoked `pim` — must be preserved for git + init file paths. */
const userCwd = process.cwd();
const cliEntry = path.join(repoRoot, "packages/cli/src/index.ts");
const requireFromRoot = createRequire(path.join(repoRoot, "package.json"));

let tsxCli;
try {
  const tsxDir = path.dirname(requireFromRoot.resolve("tsx/package.json"));
  tsxCli = path.join(tsxDir, "dist", "cli.mjs");
  if (!existsSync(tsxCli)) throw new Error("missing tsx cli");
} catch {
  console.error(
    "pim: could not resolve tsx. From the pim clone root run:\n  pnpm install\n",
  );
  process.exit(1);
}

const result = spawnSync(process.execPath, [tsxCli, cliEntry, ...process.argv.slice(2)], {
  // Never use repoRoot here: that made `pim init` from another repo write into pim
  // because `git rev-parse --show-toplevel` inherited this cwd.
  cwd: userCwd,
  stdio: "inherit",
  env: process.env,
});

process.exit(result.status ?? 1);
