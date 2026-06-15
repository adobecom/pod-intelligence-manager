import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { parseTaskSetName, pickTasks, taskSetTasks } from "../tasks/index.js";
import { makeHoldoutEntry, type HoldoutManifest } from "../rigor/holdout.js";

function argValue(name: string): string | undefined {
  const prefix = `--${name}=`;
  const match = process.argv.slice(2).find((arg) => arg.startsWith(prefix));
  return match?.slice(prefix.length);
}

async function main(): Promise<void> {
  const out = argValue("out") ?? "holdouts/holdout-haiku-v2.json";
  const tags = argValue("tags")?.split(",").filter(Boolean);
  const ids = argValue("tasks")?.split(",").filter(Boolean);
  const taskSet = argValue("task-set");
  if (taskSet && (ids?.length || tags?.length)) {
    throw new Error("--task-set cannot be combined with --tasks or --tags");
  }
  const tasks = taskSet ? taskSetTasks(parseTaskSetName(taskSet)) : pickTasks({ ids, tags });
  const manifest: HoldoutManifest = {
    id: argValue("id") ?? `pim-vs-lic-haiku-v2-${new Date().toISOString().slice(0, 10)}`,
    protocol: argValue("protocol") ?? "protocols/pim-vs-lic-haiku-v2.md",
    minimumTaskCount: Number(argValue("minimum-task-count") ?? String(tasks.length)),
    createdAt: new Date().toISOString(),
    tasks: tasks.map((t) => makeHoldoutEntry(t)),
  };
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, JSON.stringify(manifest, null, 2));
  console.log(`[make-holdout] wrote ${out} (${manifest.tasks.length} tasks, minimum ${manifest.minimumTaskCount})`);
}

main().catch((err) => {
  console.error("[make-holdout] failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
