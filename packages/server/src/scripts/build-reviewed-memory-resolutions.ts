#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { buildReviewedMemoryResolutionManifest } from "../services/reviewed-memory-cutover-policy.js";

function usage(): string {
  return [
    "Usage:",
    "  pnpm --filter @pim/server build-reviewed-memory-resolutions -- \\",
    "    --template /absolute/resolutions-template.json \\",
    "    --inventory /absolute/inventory.json \\",
    "    --policy /absolute/reviewed-policy.json \\",
    "    --output /absolute/resolutions.json",
  ].join("\n");
}

function argumentsFrom(argv: string[]): Record<string, string> {
  const args = argv[0] === "--" ? argv.slice(1) : argv;
  const result: Record<string, string> = {};
  for (let index = 0; index < args.length; index++) {
    const argument = args[index]!;
    if (!argument.startsWith("--")) throw new Error(`Unknown argument: ${argument}\n${usage()}`);
    const equals = argument.indexOf("=");
    const key = argument.slice(2, equals === -1 ? undefined : equals);
    const value = equals === -1 ? args[++index] : argument.slice(equals + 1);
    if (!value || value.startsWith("--") || result[key]) throw new Error(`Invalid --${key}\n${usage()}`);
    result[key] = path.resolve(value);
  }
  for (const key of ["template", "inventory", "policy", "output"]) {
    if (!result[key]) throw new Error(`--${key} is required\n${usage()}`);
  }
  if (Object.keys(result).some((key) => !["template", "inventory", "policy", "output"].includes(key))) {
    throw new Error(`Unknown option\n${usage()}`);
  }
  return result;
}

function readJson(filePath: string): unknown {
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
}

const options = argumentsFrom(process.argv.slice(2));
const result = buildReviewedMemoryResolutionManifest({
  resolutionTemplate: readJson(options.template!),
  inventoryReport: readJson(options.inventory!),
  policy: readJson(options.policy!),
});
const output = options.output!;
const parent = path.dirname(output);
if (!fs.statSync(parent).isDirectory()) throw new Error(`Output parent is not a directory: ${parent}`);
fs.writeFileSync(output, `${JSON.stringify(result.manifest, null, 2)}\n`, { flag: "wx" });
process.stderr.write(`${JSON.stringify({ output, ...result.summary }, null, 2)}\n`);
