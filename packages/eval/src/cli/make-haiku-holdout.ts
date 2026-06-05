import "../load-env.js";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { ALL_TASKS } from "../tasks/index.js";
import { headlineTasks } from "../tasks/stratification.js";
import { classifyPromptTier } from "../tasks/prompt-tiers.js";
import { isRealHeadlineTask, makeHoldoutEntry, type HoldoutManifest } from "../rigor/holdout.js";
import { sha256Text } from "../rigor/hash.js";
import type { LicIndexSource } from "../arms/types.js";

const __filename = fileURLToPath(import.meta.url);
const PKG_ROOT = join(dirname(__filename), "..", "..");
const HOLDOUTS_DIR = join(PKG_ROOT, "holdouts");
const LIC_FIXTURES_DIR = join(PKG_ROOT, "fixtures", "lic");
const MINIMUM_TASK_COUNT = 30;

async function maybeLicFixtureMetadata(taskId: string): Promise<{ hash?: string; indexSource?: LicIndexSource }> {
  try {
    const raw = await readFile(join(LIC_FIXTURES_DIR, `${taskId}.json`), "utf8");
    const parsed = JSON.parse(raw) as { indexSource?: LicIndexSource };
    return { hash: sha256Text(raw), indexSource: parsed.indexSource };
  } catch {
    return {};
  }
}

async function main(): Promise<void> {
  const allowHeadLeak = process.argv.slice(2).includes("--allow-head-leak");
  const tasks = headlineTasks(ALL_TASKS);
  const primaryClaimTaskCount = tasks.filter((task) => classifyPromptTier(task) === "realistic-ticket").length;
  if (primaryClaimTaskCount < MINIMUM_TASK_COUNT) {
    throw new Error(
      `primary claim has ${primaryClaimTaskCount} realistic-ticket headline tasks, below minimum ${MINIMUM_TASK_COUNT}. ` +
        `Rewrite/re-tier source-excerpt prompts or add more real-ticket tasks before generating a headline v2 holdout.`,
    );
  }

  const licMetadata = new Map(
    await Promise.all(tasks.map(async (t) => [t.id, await maybeLicFixtureMetadata(t.id)] as const)),
  );

  // Fail closed: real headline tasks must carry a parent SHA AND their lic
  // fixtures must already be frozen from that exact parent SHA. --allow-head-leak
  // generates an explicitly exploratory (not headline-clean) holdout instead.
  const headLeakReasons: string[] = [];
  for (const task of tasks) {
    if (!isRealHeadlineTask(task)) continue;
    const parentSha = task.provenance?.parentSha;
    const lic = licMetadata.get(task.id);
    if (!parentSha) {
      headLeakReasons.push(`${task.id} (${task.stratum}) lacks provenance.parentSha`);
      continue;
    }
    if (!lic?.hash) {
      headLeakReasons.push(`${task.id} (${task.stratum}) is missing a frozen lic fixture`);
      continue;
    }
    if (!lic.indexSource) {
      headLeakReasons.push(`${task.id} (${task.stratum}) lic fixture lacks indexSource`);
    } else if (lic.indexSource.kind !== "parentSha") {
      headLeakReasons.push(`${task.id} (${task.stratum}) lic fixture is ${lic.indexSource.kind}-indexed`);
    } else if (lic.indexSource.sha !== parentSha) {
      headLeakReasons.push(`${task.id} (${task.stratum}) lic fixture sha ${lic.indexSource.sha} != parentSha ${parentSha}`);
    }
  }

  if (headLeakReasons.length > 0 && !allowHeadLeak) {
    throw new Error(
      `${headLeakReasons.length} real headline lic fixture(s) are not parent-SHA clean:\n` +
        headLeakReasons.map((reason) => `  - ${reason}`).join("\n") +
        `\nRe-freeze with \`pnpm --filter @pim/eval lic-freeze -- --task=headline --refresh\`, ` +
        `or pass --allow-head-leak to generate an exploratory holdout.`,
    );
  }

  const entries = await Promise.all(
    tasks.map(async (t) => {
      const lic = licMetadata.get(t.id) ?? {};
      return makeHoldoutEntry(t, { licFixtureHash: lic.hash, licIndexSource: lic.indexSource });
    }),
  );
  const manifest: HoldoutManifest = {
    id: `pim-vs-lic-haiku-v2-${new Date().toISOString().slice(0, 10)}`,
    protocol: "protocols/pim-vs-lic-haiku-v2.md",
    minimumTaskCount: MINIMUM_TASK_COUNT,
    createdAt: new Date().toISOString(),
    ...(headLeakReasons.length > 0 && allowHeadLeak ? { headLeakWaived: true } : {}),
    tasks: entries,
  };
  await mkdir(HOLDOUTS_DIR, { recursive: true });
  const outPath = join(HOLDOUTS_DIR, "holdout-haiku-v2.json");
  await writeFile(outPath, JSON.stringify(manifest, null, 2));
  const withLic = entries.filter((e) => e.licFixtureHash).length;
  console.log(`[make-haiku-holdout] wrote ${outPath} (${entries.length} tasks, ${withLic} with lic fixtures)`);

  // Quick per-stratum summary.
  const counts: Record<string, number> = {};
  for (const e of entries) {
    const s = e.stratum ?? "unassigned";
    counts[s] = (counts[s] ?? 0) + 1;
  }
  console.log(`[make-haiku-holdout] per-stratum: ${JSON.stringify(counts)}`);
}

main().catch((err) => {
  console.error("[make-haiku-holdout] failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
