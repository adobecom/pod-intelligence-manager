#!/usr/bin/env node
/**
 * Global `pim` entry when `ado-pim` is linked (`pnpm -C packages/cli link --global`).
 * Prefer the bundled CLI so `pim` works from any cwd without tsx / workspace TS resolution.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const binDir = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(binDir, "..");
const userCwd = process.cwd();
const bundlePath = path.join(pkgRoot, "dist", "pim.bundle.cjs");
const env = { ...process.env, PIM_CLI_ROOT: pkgRoot };

if (existsSync(bundlePath)) {
  const result = spawnSync(process.execPath, [bundlePath, ...process.argv.slice(2)], {
    cwd: userCwd,
    stdio: "inherit",
    env,
  });
  process.exit(result.status ?? 1);
}

// Dev fallback: no bundle yet — run TypeScript entry via tsx
const cliEntry = path.join(pkgRoot, "src/index.ts");
const requireFromPkg = createRequire(path.join(pkgRoot, "package.json"));
let tsxCli;
try {
  const tsxDir = path.dirname(requireFromPkg.resolve("tsx/package.json"));
  tsxCli = path.join(tsxDir, "dist", "cli.mjs");
  if (!existsSync(tsxCli)) throw new Error("missing tsx cli");
} catch {
  console.error(
    "pim: no bundled CLI (dist/pim.bundle.cjs). From the monorepo run:\n  pnpm --filter ado-pim build\n",
  );
  process.exit(1);
}

const result = spawnSync(process.execPath, [tsxCli, cliEntry, ...process.argv.slice(2)], {
  cwd: userCwd,
  stdio: "inherit",
  env,
});

process.exit(result.status ?? 1);
