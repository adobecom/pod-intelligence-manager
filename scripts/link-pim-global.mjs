#!/usr/bin/env node
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolvePnpmHome } from "./resolve-pnpm-home.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const cliDir = join(repoRoot, "packages", "cli");

let pnpmHome = resolvePnpmHome();

if (!existsSync(pnpmHome)) {
  execSync("pnpm setup", { stdio: "inherit", cwd: repoRoot });
  pnpmHome = resolvePnpmHome();
}

execSync("pnpm link --global", {
  cwd: cliDir,
  stdio: "inherit",
  env: { ...process.env, PNPM_HOME: pnpmHome },
});
