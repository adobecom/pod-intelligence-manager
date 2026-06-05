import { describe, it, expect } from "vitest";
import { readdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { auditProtocol } from "../rigor/protocol.js";
import { readHoldout } from "../rigor/holdout.js";
import { sha256File } from "../rigor/hash.js";

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const HOLDOUTS_DIR = join(PKG_ROOT, "holdouts");
const PROTOCOLS_DIR = join(PKG_ROOT, "protocols");

async function holdoutFiles(): Promise<string[]> {
  const entries = await readdir(HOLDOUTS_DIR);
  return entries.filter((f) => f.endsWith(".json"));
}

describe("protocol docs", () => {
  it("every holdout references a protocol file that exists, hashes, and passes auditProtocol", async () => {
    const files = await holdoutFiles();
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const manifest = await readHoldout(join(HOLDOUTS_DIR, file));
      expect(manifest.protocol, `${file} missing protocol reference`).toBeTruthy();
      const protocolPath = join(PKG_ROOT, manifest.protocol);

      // Hashes cleanly (file exists and is readable).
      const hash = await sha256File(protocolPath);
      expect(hash, `${manifest.protocol} did not hash`).toMatch(/^[0-9a-f]{64}$/);

      // Passes the pre-registration phrase audit.
      const audit = await auditProtocol(protocolPath);
      const errors = audit.findings.filter((f) => f.level === "error").map((f) => f.message);
      expect(errors, `${manifest.protocol} failed auditProtocol: ${errors.join("; ")}`).toEqual([]);
      expect(audit.ok).toBe(true);
    }
  });

  it("every protocol doc on disk passes its own audit", async () => {
    const entries = await readdir(PROTOCOLS_DIR).catch(() => []);
    const docs = entries.filter((f) => f.endsWith(".md"));
    expect(docs.length).toBeGreaterThan(0);
    for (const doc of docs) {
      const audit = await auditProtocol(join(PROTOCOLS_DIR, doc));
      const errors = audit.findings.filter((f) => f.level === "error").map((f) => f.message);
      expect(errors, `${doc} failed auditProtocol: ${errors.join("; ")}`).toEqual([]);
    }
  });
});
