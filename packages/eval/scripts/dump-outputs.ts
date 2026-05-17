import "../src/load-env.js";
import { readFile, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { ALL_TASKS } from "../src/tasks/index.js";
import { ARMS } from "../src/arms/index.js";
import type { SessionContextFixture } from "../src/arms/types.js";
import { pickDefaultRunner } from "../src/runners/index.js";

const __filename = fileURLToPath(import.meta.url);
const PKG_ROOT = join(dirname(__filename), "..");
const FIXTURES_DIR = join(PKG_ROOT, "fixtures", "session-contexts");

const taskId = process.argv[2];
if (!taskId) {
  console.error("usage: tsx scripts/dump-outputs.ts <taskId>");
  process.exit(1);
}

const task = ALL_TASKS.find((t) => t.id === taskId);
if (!task) {
  console.error(`unknown taskId: ${taskId}`);
  process.exit(1);
}

const fixture: SessionContextFixture = JSON.parse(
  await readFile(join(FIXTURES_DIR, `${task.podId}.json`), "utf8"),
);
const runner = pickDefaultRunner();
const model =
  process.env.PIM_EVAL_MODEL ??
  process.env.BEDROCK_MODEL_SMART ??
  "us.anthropic.claude-sonnet-4-6";

for (const arm of ARMS) {
  const segments = arm.build(task, fixture);
  const res = await runner.run(segments, { model, maxOutputTokens: 4096 });
  const outPath = join(PKG_ROOT, "reports", `output-${taskId}-${arm.id}.txt`);
  await writeFile(outPath, res.text);
  console.log(`--- ${arm.id} (in=${res.usage.inputTokens} out=${res.usage.outputTokens}) -> ${outPath}`);
  console.log(res.text);
  console.log("");
}
