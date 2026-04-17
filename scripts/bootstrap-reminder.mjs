#!/usr/bin/env node
import { execSync } from "node:child_process";

let dir;
try {
  dir = execSync("pnpm bin -g", { encoding: "utf-8" }).trim();
} catch {
  dir = "$HOME/Library/pnpm";
}

console.log("\n  PIM CLI linked globally.");
console.log("  If a new terminal reports `pim: command not found`, add pnpm's bin directory to PATH, e.g.:");
console.log(`    export PATH="${dir}:$PATH"`);
console.log("  (zsh: put that in ~/.zshrc, then open a new terminal or run source ~/.zshrc.)\n");
