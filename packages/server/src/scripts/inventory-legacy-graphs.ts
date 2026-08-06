#!/usr/bin/env node
import { inventoryLegacyGraphs } from "../services/legacy-graph-inventory.js";

function usage(): string {
  return [
    "Usage:",
    "  pnpm --filter @pim/server inventory-legacy-graphs -- \\",
    "    --db /absolute/path/to/pim.db \\",
    "    --graph-root /absolute/path/to/knowledge-graph [--graph-root ...]",
  ].join("\n");
}

function parseArguments(argv: string[]): { dbPath: string; graphRoots: string[] } {
  let dbPath = "";
  const graphRoots: string[] = [];

  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === "--db") {
      dbPath = argv[++index] ?? "";
    } else if (argument.startsWith("--db=")) {
      dbPath = argument.slice("--db=".length);
    } else if (argument === "--graph-root") {
      const root = argv[++index];
      if (root) graphRoots.push(root);
    } else if (argument.startsWith("--graph-root=")) {
      graphRoots.push(argument.slice("--graph-root=".length));
    } else if (argument === "--help" || argument === "-h") {
      process.stdout.write(`${usage()}\n`);
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }

  if (!dbPath || graphRoots.length === 0) throw new Error(usage());
  return { dbPath, graphRoots };
}

try {
  const rawArguments = process.argv.slice(2);
  const options = parseArguments(rawArguments[0] === "--" ? rawArguments.slice(1) : rawArguments);
  const report = inventoryLegacyGraphs(options);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
