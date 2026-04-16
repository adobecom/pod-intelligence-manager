#!/usr/bin/env node
/**
 * Global `council` entry when this repo is linked (`pnpm link --global`).
 * Runs the CLI from TypeScript source via the workspace tsx dependency.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const binDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(binDir, "..");
const cliEntry = path.join(repoRoot, "packages/cli/src/index.ts");
const requireFromRoot = createRequire(path.join(repoRoot, "package.json"));

let tsxCli;
try {
  const tsxDir = path.dirname(requireFromRoot.resolve("tsx/package.json"));
  tsxCli = path.join(tsxDir, "dist", "cli.mjs");
  if (!existsSync(tsxCli)) throw new Error("missing tsx cli");
} catch {
  console.error(
    "council: could not resolve tsx. From the ai-council clone root run:\n  pnpm install\n",
  );
  process.exit(1);
}

const result = spawnSync(process.execPath, [tsxCli, cliEntry, ...process.argv.slice(2)], {
  cwd: repoRoot,
  stdio: "inherit",
  env: process.env,
});

process.exit(result.status ?? 1);
