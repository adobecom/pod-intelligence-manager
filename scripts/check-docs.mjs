#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();

function gitLines(args) {
  const output = execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  return output ? output.split("\n") : [];
}

function lineNumber(source, index) {
  return source.slice(0, index).split("\n").length;
}

const markdownFiles = gitLines([
  "ls-files",
  "-co",
  "--exclude-standard",
  "--",
  "*.md",
]);

const failures = [];
const markdownLink = /!?\[[^\]]*\]\(([^)]+)\)/g;

for (const relativeFile of markdownFiles) {
  const source = fs.readFileSync(path.join(root, relativeFile), "utf8");
  for (const match of source.matchAll(markdownLink)) {
    let target = match[1].trim().replace(/^<|>$/g, "");
    if (!target || /^(?:https?:|mailto:|#)/i.test(target)) continue;

    target = target.split("#", 1)[0].split("?", 1)[0];
    if (!target) continue;
    try {
      target = decodeURIComponent(target);
    } catch {
      failures.push(`${relativeFile}:${lineNumber(source, match.index)} invalid link encoding: ${match[1]}`);
      continue;
    }

    const resolved = path.resolve(root, path.dirname(relativeFile), target);
    if (!fs.existsSync(resolved)) {
      failures.push(`${relativeFile}:${lineNumber(source, match.index)} missing link target: ${match[1]}`);
    }
  }
}

const manifests = new Map();
for (const manifestPath of ["package.json", ...gitLines(["ls-files", "packages/*/package.json"])]) {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, manifestPath), "utf8"));
  const entry = {
    path: manifestPath,
    scripts: new Set(Object.keys(manifest.scripts ?? {})),
  };
  manifests.set(manifest.name ?? manifestPath, entry);
  if (manifestPath === "package.json") manifests.set("<workspace-root>", entry);
}

const pnpmCommand = /(?:^|\n)[ \t]*(?:[$>] )?pnpm(?:\s+--filter\s+([^\s\\]+))?\s+(?:run\s+)?([a-zA-Z0-9][a-zA-Z0-9:_-]*)/g;
const pnpmBuiltins = new Set([
  "add",
  "config",
  "dlx",
  "env",
  "exec",
  "fetch",
  "import",
  "install",
  "link",
  "list",
  "outdated",
  "pack",
  "patch",
  "publish",
  "rebuild",
  "remove",
  "setup",
  "store",
  "unlink",
  "update",
  "why",
]);

for (const relativeFile of markdownFiles) {
  const source = fs.readFileSync(path.join(root, relativeFile), "utf8");
  const snippets = [
    ...Array.from(source.matchAll(/```[^\n]*\n([\s\S]*?)```/g), (match) => ({
      source: match[1],
      offset: match.index,
    })),
    ...Array.from(source.matchAll(/`([^`\n]+)`/g), (match) => ({
      source: match[1],
      offset: match.index,
    })),
  ];
  for (const snippet of snippets) {
    for (const match of snippet.source.matchAll(pnpmCommand)) {
      const packageName = match[1] ?? "<workspace-root>";
      const command = match[2];
      if (pnpmBuiltins.has(command)) continue;

      const manifest = manifests.get(packageName);
      if (!manifest) {
        failures.push(`${relativeFile}:${lineNumber(source, snippet.offset + match.index)} unknown pnpm filter: ${packageName}`);
        continue;
      }
      if (!manifest.scripts.has(command)) {
        failures.push(
          `${relativeFile}:${lineNumber(source, snippet.offset + match.index)} missing script ${packageName}:${command} (${manifest.path})`,
        );
      }
    }
  }
}

if (failures.length > 0) {
  console.error(`Documentation check failed (${failures.length}):`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(`Documentation check passed (${markdownFiles.length} Markdown files).`);
