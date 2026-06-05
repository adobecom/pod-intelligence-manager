import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { PromptSegments, RunUsage } from "../runners/types.js";
import type { JudgeResult } from "../judges/types.js";
import type { LicContextFixture, SessionContextFixture } from "../arms/types.js";
import type { EvalRow } from "../report.js";
import type { LicFixtureQuality } from "./lic-quality.js";

export interface RunManifest {
  runId: string;
  generatedAt: string;
  gitSha?: string;
  holdoutId?: string;
  protocolPath?: string;
  protocolHash?: string;
  holdoutPath?: string;
  holdoutHash?: string;
  runner: string;
  model: string;
  judgeRunner?: string;
  judgeModel: string;
  seeds: number;
  temperature?: number;
  arms: string[];
  tasks: string[];
  taskStrata?: Record<string, string>;
  /** Per-task point-in-time cutoff (ISO) applied to PIM context, for the temporal audit. */
  taskAsOf?: Record<string, string>;
  fixtureHashes: Record<string, string>;
  /** Per-task lic fixture hashes (only present for runs that used a lic arm). */
  licFixtureHashes?: Record<string, string>;
  /** Per-task deterministic lic fixture-quality metadata. */
  licFixtureQuality?: Record<string, LicFixtureQuality>;
  filter: { taskIds?: string[]; tags?: string[]; arms?: string[] };
}

export interface PromptArtifact {
  runId: string;
  taskId: string;
  arm: string;
  seed: number;
  prompt: PromptSegments;
}

export interface ApiCallArtifact {
  runId: string;
  taskId: string;
  arm: string;
  seed: number;
  runner: string;
  model: string;
  latencyMs: number;
  usage: RunUsage;
  providerRequestId?: string;
  serverTimestamp?: string;
  cacheState?: string;
  error?: string;
}

export interface OutputArtifact {
  runId: string;
  candidateId: string;
  taskId: string;
  arm: string;
  seed: number;
  output: string;
  judge: JudgeResult;
}

export async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, JSON.stringify(value, null, 2));
}

export async function appendJsonl(path: string, values: unknown[]): Promise<void> {
  await writeFile(path, values.map((v) => JSON.stringify(v)).join("\n") + (values.length ? "\n" : ""));
}

export async function writeRunArtifacts(params: {
  runDir: string;
  manifest: RunManifest;
  prompts: PromptArtifact[];
  apiCalls: ApiCallArtifact[];
  outputs: OutputArtifact[];
  rows: EvalRow[];
  fixtures: Map<string, SessionContextFixture>;
  licFixtures?: Map<string, LicContextFixture>;
  /** Per-task point-in-time PIM snapshots (asOf-filtered), keyed by task id. */
  scopedFixtures?: Map<string, SessionContextFixture>;
}): Promise<void> {
  const { runDir, manifest, prompts, apiCalls, outputs, rows, fixtures, licFixtures, scopedFixtures } = params;
  await mkdir(runDir, { recursive: true });
  await mkdir(join(runDir, "prompts"), { recursive: true });
  await mkdir(join(runDir, "fixtures"), { recursive: true });
  await mkdir(join(runDir, "fixtures", "lic"), { recursive: true });
  await mkdir(join(runDir, "fixtures", "scoped"), { recursive: true });
  await mkdir(join(runDir, "judge-inputs"), { recursive: true });
  await mkdir(join(runDir, "judge-outputs"), { recursive: true });
  await writeJson(join(runDir, "manifest.json"), manifest);
  await appendJsonl(join(runDir, "api-calls.jsonl"), apiCalls);
  await appendJsonl(join(runDir, "outputs.jsonl"), outputs);
  await appendJsonl(join(runDir, "rows.jsonl"), rows);
  await writeJson(join(runDir, "analysis.json"), { status: "pending", note: "Run completed; execute analyze for claim decision." });
  await appendJsonl(join(runDir, "exclusions.jsonl"), []);
  await appendJsonl(join(runDir, "human-review.jsonl"), []);

  for (const prompt of prompts) {
    await writeJson(join(runDir, "prompts", `${prompt.taskId}__${prompt.arm}__seed-${prompt.seed}.json`), prompt);
  }
  for (const [key, fixture] of fixtures) {
    await writeJson(join(runDir, "fixtures", `${key}.json`), fixture);
  }
  for (const [key, fixture] of licFixtures ?? []) {
    await writeJson(join(runDir, "fixtures", "lic", `${key}.json`), fixture);
  }
  for (const [taskId, fixture] of scopedFixtures ?? []) {
    await writeJson(join(runDir, "fixtures", "scoped", `${taskId}.json`), fixture);
  }
}
