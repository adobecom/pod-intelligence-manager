import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const serverSrc = path.resolve(testDir, "../..");
const sharedContracts = path.resolve(testDir, "../../../../shared/contracts");

const ACTIVE_ADJACENT_FILES = new Set([
  "routes/memory-receipts.ts",
  "services/memory-activation.ts",
  "services/memory-candidates.ts",
  "services/memory-harness-activation.ts",
  "services/memory-harness-records.ts",
  "services/memory-receipts.ts",
  "services/memory-records.ts",
]);

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) return entry.name === "__tests__" ? [] : sourceFiles(target);
    return entry.isFile() && entry.name.endsWith(".ts") ? [target] : [];
  });
}

function activeServerSources(): string[] {
  return ["middleware", "routes", "services"].flatMap((directory) => (
    sourceFiles(path.join(serverSrc, directory))
  )).filter((file) => {
    const relative = path.relative(serverSrc, file);
    return path.basename(file).includes("memory-v2")
      || path.basename(file).includes("memory-mcp")
      || ACTIVE_ADJACENT_FILES.has(relative);
  });
}

function contractRoots(): string[] {
  return readdirSync(sharedContracts, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /memory-contract.*\.(?:json|md)$/.test(entry.name))
    .map((entry) => path.join(sharedContracts, entry.name));
}

function literalHarnessBranches(source: string): string[] {
  return source.split("\n").filter((line) => {
    if (line.includes("typeof")) return false;
    return /(?:harness_id|harnessId)\s*(?:===|!==|==|!=)\s*["'`][^"'`]+["'`]/.test(line)
      || /["'`][^"'`]+["'`]\s*(?:===|!==|==|!=)\s*[^\n]*(?:harness_id|harnessId)/.test(line);
  });
}

describe("active v2 PIM source remains harness-neutral", () => {
  it("contains no Fiesta identifier or literal harness-id branch", () => {
    const violations = [...activeServerSources(), ...contractRoots()].flatMap((file) => {
      const source = readFileSync(file, "utf8");
      const reasons = [
        ...(/fiesta/i.test(source) ? ["Fiesta identifier"] : []),
        ...literalHarnessBranches(source).map((line) => `literal harness branch: ${line.trim()}`),
      ];
      return reasons.map((reason) => `${path.relative(process.cwd(), file)}: ${reason}`);
    });

    expect(violations).toEqual([]);
  });
});
