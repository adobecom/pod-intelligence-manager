/**
 * End-to-end orchestrator: mine → classify → submit, for the four known
 * T3 Events repos. Each repo's pipeline runs sequentially. Intermediate
 * artifacts land under scripts/candidates/ and scripts/classified/ so any
 * stage can be re-run on its own (each script's CLI accepts --in / --out).
 *
 * Auth required (set in shell or packages/eval/.env):
 *   ANTHROPIC_API_KEY    — for the classifier (Claude Haiku 4.5)
 *   GITHUB_TOKEN         — for adobecom/EMC and adobecom/event-libs
 *   GITCORP_TOKEN        — for git.corp.adobe.com/wcms/*
 *
 * Plus an active PIM session (`mcp__ai-council__authenticate` already ran
 * in this Claude Code session, so ~/.pim/credentials.json is current).
 *
 * Usage:
 *   pnpm exec tsx scripts/seed-t3-events.ts                   # full run
 *   pnpm exec tsx scripts/seed-t3-events.ts --repos adobecom/EMC
 *   pnpm exec tsx scripts/seed-t3-events.ts --stage mine      # only the mining stage
 *   pnpm exec tsx scripts/seed-t3-events.ts --dry-run         # mine + classify, no submit
 */

import "../src/load-env.js";
import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

interface RepoSpec {
  repo: string;
  host: "github.com" | "git.corp.adobe.com";
}

const DEFAULT_REPOS: RepoSpec[] = [
  { repo: "adobecom/EMC", host: "github.com" },
  { repo: "adobecom/event-libs", host: "github.com" },
  { repo: "wcms/events-service-platform", host: "git.corp.adobe.com" },
  { repo: "wcms/events-service-layer", host: "git.corp.adobe.com" },
];

interface Args {
  repos: RepoSpec[];
  stage: "all" | "mine" | "classify" | "submit";
  dryRun: boolean;
  org: string;
  maxPrs: number;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { repos: DEFAULT_REPOS, stage: "all", dryRun: false, org: "emc-sandbox", maxPrs: 500 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = argv[i + 1];
    switch (a) {
      case "--repos":
        args.repos = next.split(",").map((slug) => {
          const trimmed = slug.trim();
          const known = DEFAULT_REPOS.find((r) => r.repo === trimmed);
          if (known) return known;
          return { repo: trimmed, host: trimmed.startsWith("wcms/") ? "git.corp.adobe.com" : "github.com" };
        });
        i++;
        break;
      case "--stage": args.stage = next as Args["stage"]; i++; break;
      case "--dry-run": args.dryRun = true; break;
      case "--org": args.org = next; i++; break;
      case "--max-prs": args.maxPrs = Number(next); i++; break;
      default:
        if (a.startsWith("--")) throw new Error(`Unknown flag: ${a}`);
    }
  }
  return args;
}

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, "..");

function safeName(spec: RepoSpec): string {
  return `${spec.host}-${spec.repo}`.replace(/[/.]/g, "-");
}

function candidatesPath(spec: RepoSpec): string {
  return join(ROOT, "scripts", "candidates", `${safeName(spec)}.json`);
}

function classifiedPath(spec: RepoSpec): string {
  return join(ROOT, "scripts", "classified", `${safeName(spec)}.json`);
}

function runStage(script: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("pnpm", ["exec", "tsx", script, ...args], {
      cwd: ROOT,
      stdio: "inherit",
      env: process.env,
    });
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${script} exited with code ${code}`));
    });
    child.on("error", reject);
  });
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  console.log(
    `[seed-t3] repos=${args.repos.map((r) => `${r.host}:${r.repo}`).join(", ")} stage=${args.stage}${args.dryRun ? " DRY-RUN" : ""}`,
  );
  await mkdir(join(ROOT, "scripts", "candidates"), { recursive: true });
  await mkdir(join(ROOT, "scripts", "classified"), { recursive: true });

  for (const spec of args.repos) {
    const candOut = candidatesPath(spec);
    const classOut = classifiedPath(spec);
    console.log(`\n=== ${spec.host}/${spec.repo} ===`);

    if (args.stage === "all" || args.stage === "mine") {
      await runStage("scripts/mine-repo.ts", [
        "--repo", spec.repo,
        "--host", spec.host,
        "--out", candOut,
        "--max-prs", String(args.maxPrs),
      ]);
    }
    if (args.stage === "all" || args.stage === "classify") {
      await runStage("scripts/classify-candidates.ts", [
        "--in", candOut,
        "--out", classOut,
      ]);
    }
    if (args.stage === "all" || args.stage === "submit") {
      const submitArgs = ["--in", classOut, "--org", args.org];
      if (args.dryRun) submitArgs.push("--dry-run");
      await runStage("scripts/submit-candidates.ts", submitArgs);
    }
  }

  console.log("\n[seed-t3] all repos done");
}

main().catch((err) => {
  console.error("[seed-t3] error:", err instanceof Error ? err.message : err);
  process.exit(1);
});
