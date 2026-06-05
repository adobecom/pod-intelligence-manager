import "../load-env.js";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { ALL_TASKS } from "../tasks/index.js";
import { applyAssignment } from "../tasks/stratification.js";
import type { Task } from "../tasks/types.js";
import { renderBlock, sanitizeProductName, sha256Hex } from "./lic-freeze.js";
import { deriveLicFixtureQuality } from "../rigor/lic-quality.js";
import type { LicContextFixture } from "../arms/types.js";

/**
 * One-shot migration that scrubs the upstream tool's product name out of the
 * frozen locally-indexed-code fixtures (finding #5). The fixtures were frozen by
 * an older binary and still say `scoutDaemonVersion`, `# Scout Context`, and
 * `## scout <tool>`. This:
 *
 *   1. renames `scoutDaemonVersion` -> `licDaemonVersion` and scrubs its value,
 *   2. scrubs the product token from `recipe` strings and each captured
 *      `calls[].output` (tool self-references / cache paths — never EMC code),
 *   3. re-renders `renderedBlock` from the scrubbed calls with the CURRENT lic
 *      renderer (so headers become `# Lic Context` / `## lic`), or scrubs the
 *      existing block in place when a fixture has no calls (hand-authored synth),
 *   4. recomputes `renderedBlockHash` and the deterministic `quality`.
 *
 * Idempotent: re-running on already-clean fixtures is a no-op. After running,
 * regenerate the holdouts so their licFixtureHashes match.
 *
 * Usage: pnpm --filter @pim/eval lic-migrate [--dry-run]
 */
const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "fixtures", "lic");

function taskMap(): Map<string, Task> {
  return new Map(ALL_TASKS.map((t) => [t.id, applyAssignment(t)]));
}

interface RawFixture extends LicContextFixture {
  stratum?: string;
  scoutDaemonVersion?: string;
  licDaemonVersion?: string;
  calls?: Array<{ tool: string; args: string[]; cwd: string; exitCode: number | null; durationMs: number; output: string }>;
}

async function main(): Promise<void> {
  const dryRun = process.argv.slice(2).includes("--dry-run");
  const tasks = taskMap();
  const files = (await readdir(FIXTURES_DIR)).filter((f) => f.endsWith(".json"));

  let changed = 0;
  let leakRemaining = 0;
  for (const file of files) {
    const path = join(FIXTURES_DIR, file);
    const before = await readFile(path, "utf8");
    if (!/scout/i.test(before)) continue; // already clean
    const fixture = JSON.parse(before) as RawFixture;

    // Rebuild preserving key order; swap the version key in place.
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(fixture)) {
      if (k === "scoutDaemonVersion") out.licDaemonVersion = typeof v === "string" ? sanitizeProductName(v) : v;
      else out[k] = v;
    }

    if (Array.isArray(out.recipe)) {
      out.recipe = (out.recipe as string[]).map((r) => sanitizeProductName(r));
    }

    // indexSource.worktree / .repo paths carry the old `emcV2-scout-worktrees` dir.
    if (out.indexSource && typeof out.indexSource === "object") {
      const src = { ...(out.indexSource as Record<string, unknown>) };
      for (const [k, v] of Object.entries(src)) if (typeof v === "string") src[k] = sanitizeProductName(v);
      out.indexSource = src;
    }

    const calls = fixture.calls;
    if (Array.isArray(calls)) {
      // Scrub every string a call carries: cwd and args are worktree paths
      // (`emcV2-scout-worktrees`), output has tool self-references / cache paths.
      const scrubbedCalls = calls.map((c) => ({
        ...c,
        cwd: typeof c.cwd === "string" ? sanitizeProductName(c.cwd) : c.cwd,
        args: Array.isArray(c.args) ? c.args.map((a) => (typeof a === "string" ? sanitizeProductName(a) : a)) : c.args,
        output: sanitizeProductName(c.output ?? ""),
      }));
      out.calls = scrubbedCalls;
    }

    // Re-render from scrubbed calls (current renderer) when present; otherwise
    // scrub the hand-authored block text in place.
    let rendered: string;
    if (Array.isArray(calls) && calls.length > 0) {
      rendered = renderBlock({ id: fixture.taskId, stratum: fixture.stratum as Task["stratum"] }, out.calls as any);
    } else {
      rendered = sanitizeProductName(fixture.renderedBlock ?? "");
    }
    out.renderedBlock = rendered;
    out.renderedBlockHash = sha256Hex(rendered);

    // Recompute quality against the scrubbed block.
    const task = tasks.get(fixture.taskId);
    if (task) out.quality = deriveLicFixtureQuality(task, out as unknown as LicContextFixture);

    const after = JSON.stringify(out, null, 2);
    if (/scout/i.test(after)) {
      leakRemaining++;
      console.warn(`[lic-migrate] WARNING: ${file} still contains "scout" after scrub — inspect manually`);
    }
    if (after !== before) {
      changed++;
      if (dryRun) console.log(`[lic-migrate] would migrate ${file}`);
      else {
        await writeFile(path, after);
        console.log(`[lic-migrate] migrated ${file}`);
      }
    }
  }

  console.log(`[lic-migrate] ${dryRun ? "(dry-run) " : ""}${changed} fixture(s) migrated, ${leakRemaining} with residual leak`);
  if (leakRemaining > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error("[lic-migrate] failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
