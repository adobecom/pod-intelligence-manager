#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

type Command = "prepare" | "template" | "plan" | "apply" | "reconcile" | "compare";

interface CliOptions {
  command: Command;
  dbPath: string;
  graphRoots: string[];
  inventoryPath?: string;
  resolutionsPath?: string;
  actorId?: string;
  importRunId?: string;
}

interface LegacyMigrationModule {
  createMemoryLegacyResolutionTemplate(input: {
    graphRoots: string[];
    inventoryReport: unknown;
  }): unknown;
  planMemoryLegacyMigration(input: {
    graphRoots: string[];
    inventoryReport: unknown;
    resolutionManifest: unknown;
    actorId?: string;
  }): unknown;
  applyMemoryLegacyMigration(input: {
    graphRoots: string[];
    inventoryReport: unknown;
    resolutionManifest: unknown;
    actorId?: string;
  }): unknown;
  reconcileMemoryLegacyMigration(importRunId: string): unknown;
  compareMemoryLegacyDualRead(importRunId: string): unknown;
}

function usage(): string {
  return [
    "Usage:",
    "  pnpm --filter @pim/server migrate-legacy-memory -- prepare \\",
    "    --db /absolute/path/to/pim.db",
    "  pnpm --filter @pim/server migrate-legacy-memory -- template \\",
    "    --db /absolute/path/to/pim.db --inventory inventory.json \\",
    "    --graph-root /absolute/graph/root [--graph-root ...]",
    "  pnpm --filter @pim/server migrate-legacy-memory -- plan \\",
    "    --db /absolute/path/to/pim.db --inventory inventory.json \\",
    "    --resolutions resolutions.json --graph-root /absolute/graph/root [--graph-root ...]",
    "  pnpm --filter @pim/server migrate-legacy-memory -- apply \\",
    "    --db /absolute/path/to/pim.db --inventory inventory.json \\",
    "    --resolutions resolutions.json --graph-root /absolute/graph/root [--actor operator-id]",
    "  pnpm --filter @pim/server migrate-legacy-memory -- reconcile \\",
    "    --db /absolute/path/to/pim.db --import-run-id IMPORT_RUN_ID",
    "  pnpm --filter @pim/server migrate-legacy-memory -- compare \\",
    "    --db /absolute/path/to/pim.db --import-run-id IMPORT_RUN_ID",
  ].join("\n");
}

function takeValue(argv: string[], index: number, option: string): string {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${option} requires a value`);
  return value;
}

function parseArguments(argv: string[]): CliOptions {
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(`${usage()}\n`);
    process.exit(0);
  }

  const command = argv[0];
  if (command !== "prepare" && command !== "template" && command !== "plan"
      && command !== "apply" && command !== "reconcile" && command !== "compare") {
    throw new Error(usage());
  }

  let dbPath = "";
  let inventoryPath: string | undefined;
  let resolutionsPath: string | undefined;
  let actorId: string | undefined;
  let importRunId: string | undefined;
  const graphRoots: string[] = [];

  for (let index = 1; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === "--db") {
      dbPath = takeValue(argv, index, argument);
      index++;
    } else if (argument.startsWith("--db=")) {
      dbPath = argument.slice("--db=".length);
    } else if (argument === "--inventory") {
      inventoryPath = takeValue(argv, index, argument);
      index++;
    } else if (argument.startsWith("--inventory=")) {
      inventoryPath = argument.slice("--inventory=".length);
    } else if (argument === "--resolutions") {
      resolutionsPath = takeValue(argv, index, argument);
      index++;
    } else if (argument.startsWith("--resolutions=")) {
      resolutionsPath = argument.slice("--resolutions=".length);
    } else if (argument === "--graph-root") {
      graphRoots.push(takeValue(argv, index, argument));
      index++;
    } else if (argument.startsWith("--graph-root=")) {
      graphRoots.push(argument.slice("--graph-root=".length));
    } else if (argument === "--actor") {
      actorId = takeValue(argv, index, argument);
      index++;
    } else if (argument.startsWith("--actor=")) {
      actorId = argument.slice("--actor=".length);
    } else if (argument === "--import-run-id") {
      importRunId = takeValue(argv, index, argument);
      index++;
    } else if (argument.startsWith("--import-run-id=")) {
      importRunId = argument.slice("--import-run-id=".length);
    } else {
      throw new Error(`Unknown argument: ${argument}\n${usage()}`);
    }
  }

  if (!dbPath) throw new Error(`--db is required\n${usage()}`);
  if (command === "reconcile" || command === "compare") {
    if (!importRunId) throw new Error(`--import-run-id is required for ${command}\n${usage()}`);
  } else if (command === "template" && (!inventoryPath || graphRoots.length === 0)) {
    throw new Error(`--inventory and at least one --graph-root are required\n${usage()}`);
  } else if (command !== "prepare" && (!inventoryPath || !resolutionsPath || graphRoots.length === 0)) {
    throw new Error(`--inventory, --resolutions, and at least one --graph-root are required\n${usage()}`);
  }

  return {
    command,
    dbPath: path.resolve(dbPath),
    graphRoots: [...new Set(graphRoots.map((root) => path.resolve(root)))].sort(),
    ...(inventoryPath ? { inventoryPath: path.resolve(inventoryPath) } : {}),
    ...(resolutionsPath ? { resolutionsPath: path.resolve(resolutionsPath) } : {}),
    ...(actorId ? { actorId } : {}),
    ...(importRunId ? { importRunId } : {}),
  };
}

function readJson(filePath: string): unknown {
  const value: unknown = JSON.parse(fs.readFileSync(filePath, "utf8"));
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Expected a JSON object: ${filePath}`);
  }
  return value;
}

async function main(): Promise<void> {
  const rawArguments = process.argv.slice(2);
  const options = parseArguments(rawArguments[0] === "--" ? rawArguments.slice(1) : rawArguments);
  let databaseStat: fs.Stats;
  try {
    databaseStat = fs.statSync(options.dbPath);
  } catch {
    throw new Error(`Database is absent: ${options.dbPath}`);
  }
  if (!databaseStat.isFile()) throw new Error(`Database is not a regular file: ${options.dbPath}`);

  // connection.ts reads DB_PATH during module initialization, so the target must
  // be pinned before loading the migration service.
  process.env.DB_PATH = options.dbPath;
  if (options.command === "prepare") {
    const schemaModule = await import("../db/schema.js");
    const migrationsModule = await import("../db/migrations.js");
    const authorityModule = await import("../services/memory-authority.js");
    const connectionModule = await import("../db/connection.js");
    schemaModule.createTables();
    const applied = connectionModule.default.prepare(
      "SELECT COUNT(*) AS count FROM schema_migrations",
    ).get() as { count: number };
    process.stdout.write(`${JSON.stringify({
      schema_migrations: {
        applied: applied.count,
        expected: migrationsModule.memorySchemaMigrationCount(),
      },
      memory_authority: authorityModule.getMemoryAuthorityState(),
    }, null, 2)}\n`);
    return;
  }
  const loaded: unknown = await import("../services/memory-legacy-migration.js");
  const migration = loaded as LegacyMigrationModule;

  let report: unknown;
  if (options.command === "reconcile") {
    report = migration.reconcileMemoryLegacyMigration(options.importRunId!);
  } else if (options.command === "compare") {
    report = migration.compareMemoryLegacyDualRead(options.importRunId!);
  } else if (options.command === "template") {
    report = migration.createMemoryLegacyResolutionTemplate({
      graphRoots: options.graphRoots,
      inventoryReport: readJson(options.inventoryPath!),
    });
  } else {
    const input = {
      graphRoots: options.graphRoots,
      inventoryReport: readJson(options.inventoryPath!),
      resolutionManifest: readJson(options.resolutionsPath!),
      ...(options.actorId ? { actorId: options.actorId } : {}),
    };
    report = options.command === "plan"
      ? migration.planMemoryLegacyMigration(input)
      : migration.applyMemoryLegacyMigration(input);
  }

  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
