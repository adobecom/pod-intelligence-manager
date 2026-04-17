#!/usr/bin/env node
/**
 * `council` bin when `@council/cli` is linked or installed.
 * Runs the CLI from TypeScript via tsx (same behavior as the monorepo root wrapper).
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const binDir = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(binDir, "..");
const userCwd = process.cwd();
const cliEntry = path.join(pkgRoot, "src/index.ts");
const requireFromPkg = createRequire(path.join(pkgRoot, "package.json"));

let tsxCli;
try {
  const tsxDir = path.dirname(requireFromPkg.resolve("tsx/package.json"));
  tsxCli = path.join(tsxDir, "dist", "cli.mjs");
  if (!existsSync(tsxCli)) throw new Error("missing tsx cli");
} catch {
  console.error(
    "council: could not resolve tsx. In the ai-council workspace run:\n  pnpm install\n",
  );
  process.exit(1);
}

const result = spawnSync(process.execPath, [tsxCli, cliEntry, ...process.argv.slice(2)], {
  cwd: userCwd,
  stdio: "inherit",
  env: process.env,
});

process.exit(result.status ?? 1);
