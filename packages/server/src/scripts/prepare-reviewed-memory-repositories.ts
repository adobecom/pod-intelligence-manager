#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

function option(argv: string[], name: string): string {
  const index = argv.indexOf(name);
  const inline = argv.find((value) => value.startsWith(`${name}=`));
  const value = inline?.slice(name.length + 1) ?? (index === -1 ? undefined : argv[index + 1]);
  if (!value || value.startsWith("--")) throw new Error(`${name} is required`);
  return path.resolve(value);
}

const raw = process.argv.slice(2);
const argv = raw[0] === "--" ? raw.slice(1) : raw;
const dbPath = option(argv, "--db");
const policyPath = option(argv, "--policy");
const outputPath = option(argv, "--output");
if (!fs.statSync(dbPath).isFile()) throw new Error(`Database is not a regular file: ${dbPath}`);
if (!fs.statSync(policyPath).isFile()) throw new Error(`Policy is not a regular file: ${policyPath}`);
if (!fs.statSync(path.dirname(outputPath)).isDirectory()) {
  throw new Error(`Output parent is not a directory: ${path.dirname(outputPath)}`);
}
process.env.DB_PATH = dbPath;
const service = await import("../services/reviewed-memory-repository-preparation.js");
const policy = JSON.parse(fs.readFileSync(policyPath, "utf8")) as unknown;
const report = service.prepareReviewedMemoryRepositories(policy);
fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
