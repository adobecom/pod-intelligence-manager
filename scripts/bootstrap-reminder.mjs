#!/usr/bin/env node
import { execSync } from "node:child_process";
import { resolvePnpmHome } from "./resolve-pnpm-home.mjs";

const pnpmHome = resolvePnpmHome();
let dir;
try {
  dir = execSync("pnpm bin -g", {
    encoding: "utf-8",
    env: { ...process.env, PNPM_HOME: pnpmHome },
  }).trim();
} catch {
  dir = "";
}
if (!dir) dir = pnpmHome;

console.log("\n  PIM CLI linked globally.");
console.log("  If a new terminal reports `pim: command not found`, add pnpm's bin directory to PATH, e.g.:");
console.log(`    export PATH="${dir}:$PATH"`);
console.log("  (zsh: put that in ~/.zshrc, then open a new terminal or run source ~/.zshrc.)\n");
