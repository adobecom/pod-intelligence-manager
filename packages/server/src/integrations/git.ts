import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import type { ContextSearchHit } from "@council/shared";
import { type IntegrationResult, type IntegrationSearchOpts, truncate } from "./types.js";
import db from "../db/connection.js";

const exec = promisify(execFile);

// Local git log/blame. Requires a known repo path for the pod.
// Pod schema does not yet include repo_path — this reads an optional
// `repo_path` column if present (v2 migration). When absent, the source
// is reported as missing with a clear reason.

function podRepoPath(podId: string | undefined): string | null {
  if (!podId) return null;
  try {
    const row = db
      .prepare("SELECT repo_path FROM pods WHERE pod_id = ?")
      .get(podId) as { repo_path?: string } | undefined;
    const p = row?.repo_path;
    if (p && fs.existsSync(p)) return p;
  } catch {
    // repo_path column may not exist yet — silently fall through
  }
  return null;
}

async function gitLog(
  cwd: string,
  args: string[],
  opts: IntegrationSearchOpts,
): Promise<ContextSearchHit[]> {
  const format = "%H%x1f%an%x1f%aI%x1f%s%x1f%b%x1e";
  const { stdout } = await exec(
    "git",
    ["log", `--format=${format}`, `-n`, String(opts.max_hits_per_source), ...args],
    { cwd, maxBuffer: 4 * 1024 * 1024 },
  );

  return stdout
    .split("\x1e")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map<ContextSearchHit>((entry) => {
      const [hash, author, date, subject, body] = entry.split("\x1f");
      return {
        source: "git",
        title: `${hash?.slice(0, 7) ?? "?"}: ${subject ?? ""}`,
        snippet: truncate(body ?? subject ?? ""),
        author,
        timestamp: date,
        metadata: { hash, repo_path: cwd },
      };
    });
}

export async function searchGit(opts: IntegrationSearchOpts): Promise<IntegrationResult> {
  const repo = podRepoPath(opts.pod_id);
  if (!repo) {
    return {
      source: "git",
      hits: [],
      missing: opts.pod_id
        ? `No repo_path recorded for pod ${opts.pod_id} (pods.repo_path column absent or empty)`
        : "No pod_id supplied — local git search is pod-scoped",
    };
  }

  try {
    const [grepHits, pickaxeHits] = await Promise.all([
      gitLog(repo, ["--grep", opts.query, "--regexp-ignore-case"], opts),
      gitLog(repo, ["-S", opts.query], opts),
    ]);

    const seen = new Set<string>();
    const merged: ContextSearchHit[] = [];
    for (const h of [...grepHits, ...pickaxeHits]) {
      const key = (h.metadata as { hash?: string } | undefined)?.hash ?? h.title;
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(h);
    }

    return { source: "git", hits: merged.slice(0, opts.max_hits_per_source) };
  } catch (err) {
    return {
      source: "git",
      hits: [],
      missing: `git error: ${(err as Error).message}`,
    };
  }
}
