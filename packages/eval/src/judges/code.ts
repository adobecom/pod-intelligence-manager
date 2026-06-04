import { spawn } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Task, TestCase } from "../tasks/types.js";
import type { JudgeResult } from "./types.js";

const RESULT_PREFIX = "PIM_EVAL_RESULT::";
const DEFAULT_TIMEOUT_MS = 30_000;
const require = createRequire(import.meta.url);
const TSX_LOADER_IMPORT_SPECIFIER = pathToFileURL(require.resolve("tsx")).href;

interface RunnerResult {
  results: Array<{ name: string; passed: boolean; error?: string }>;
}

export async function judgeCode(task: Task, output: string): Promise<JudgeResult> {
  if (task.type !== "code") {
    return { passed: false, score: 0, detail: "judgeCode called on non-code task" };
  }
  if (!task.tests || task.tests.length === 0) {
    return { passed: false, score: 0, detail: "task has no test cases" };
  }

  const code = extractCodeBlock(output);
  if (!code) {
    return {
      passed: false,
      score: 0,
      detail: "no fenced code block found in agent output",
      failures: task.tests.map((t) => `${t.name}: no code extracted`),
    };
  }

  const dir = await mkdtemp(join(tmpdir(), "pim-eval-"));
  try {
    const candidatePath = join(dir, "candidate.ts");
    const runnerPath = join(dir, "runner.ts");
    await writeFile(candidatePath, buildCandidate(code, task.testHarness));
    await writeFile(runnerPath, buildRunner(task.tests));

    const exec = await runProcess(process.execPath, ["--import", TSX_LOADER_IMPORT_SPECIFIER, runnerPath], {
      cwd: dir,
      timeoutMs: DEFAULT_TIMEOUT_MS,
    });

    const result = parseResult(exec.stdout);
    if (!result) {
      return {
        passed: false,
        score: 0,
        detail: `runner did not emit a result line (exit=${exec.code}). stderr: ${exec.stderr.slice(0, 400)}`,
        failures: task.tests.map((t) => `${t.name}: runner crashed`),
      };
    }

    const failures = result.results
      .filter((r) => !r.passed)
      .map((r) => `${r.name}: ${r.error ?? "failed"}`);
    const passedAll = failures.length === 0;
    return {
      passed: passedAll,
      score: passedAll ? 1 : 0,
      detail: passedAll
        ? `all ${result.results.length} tests passed`
        : `${failures.length}/${result.results.length} tests failed`,
      failures: failures.length ? failures : undefined,
    };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

function extractCodeBlock(text: string): string | null {
  const fences = [...text.matchAll(/```(?:typescript|ts|javascript|js)?\s*\n([\s\S]*?)```/g)];
  if (fences.length === 0) return null;
  // Prefer the largest fenced block (in case the model dumps a tiny example before the real one).
  return fences.reduce((best, m) => (m[1].length > best.length ? m[1] : best), "");
}

function buildCandidate(code: string, harness?: string): string {
  return [harness ?? "", "", code].join("\n");
}

function buildRunner(tests: TestCase[]): string {
  return [
    `import * as mod from "./candidate.ts";`,
    `import assert from "node:assert/strict";`,
    `(async () => {`,
    `  const results: Array<{ name: string; passed: boolean; error?: string }> = [];`,
    ...tests.map((t) => buildOneTest(t)),
    `  process.stdout.write("\\n${RESULT_PREFIX}" + JSON.stringify({ results }) + "\\n");`,
    `})().catch((err) => {`,
    `  process.stderr.write("runner top-level: " + (err?.stack ?? String(err)));`,
    `  process.exit(2);`,
    `});`,
  ].join("\n");
}

function buildOneTest(t: TestCase): string {
  // Each test runs in its own try/catch so one failure doesn't abort the whole batch.
  const safeName = JSON.stringify(t.name);
  return [
    `  try {`,
    `    await (async () => { ${t.body} })();`,
    `    results.push({ name: ${safeName}, passed: true });`,
    `  } catch (err) {`,
    `    const msg = err instanceof Error ? err.message : String(err);`,
    `    results.push({ name: ${safeName}, passed: false, error: msg });`,
    `  }`,
  ].join("\n");
}

function parseResult(stdout: string): RunnerResult | null {
  const idx = stdout.lastIndexOf(RESULT_PREFIX);
  if (idx < 0) return null;
  const rest = stdout.slice(idx + RESULT_PREFIX.length);
  const newline = rest.indexOf("\n");
  const json = newline >= 0 ? rest.slice(0, newline) : rest;
  try {
    return JSON.parse(json) as RunnerResult;
  } catch {
    return null;
  }
}

interface ProcResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

function runProcess(cmd: string, args: string[], opts: { cwd: string; timeoutMs: number }): Promise<ProcResult> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: { ...process.env, NODE_OPTIONS: "" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
    }, opts.timeoutMs);
    let timedOut = false;
    child.on("exit", (code, signal) => {
      clearTimeout(timer);
      if (signal === "SIGKILL") timedOut = true;
      resolve({ code, stdout, stderr, timedOut });
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr: stderr + "\nspawn error: " + err.message, timedOut });
    });
  });
}
