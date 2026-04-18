/**
 * Invoked by git post-commit / post-rewrite hooks (see hooks.ts).
 * Uses raw fetch — keep dependencies minimal for fast hook execution.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolveConfig, type PimConfig } from "../config.js";

function orgHeaders(config: PimConfig): Record<string, string> {
  const base: Record<string, string> = { "Content-Type": "application/json" };
  if (config.orgSlug) base["X-Pim-Org"] = config.orgSlug;
  return base;
}

function git(args: string[]): string {
  const r = spawnSync("git", args, { encoding: "utf-8" });
  if (r.error) throw r.error;
  return (r.stdout ?? "").trim();
}

function fail(msg: string, strict: boolean): void {
  console.error(`[pim-hook] ${msg}`);
  if (strict) process.exit(1);
  process.exit(0);
}

async function postCommit(): Promise<void> {
  const config = resolveConfig();
  const strict = process.env.PIM_HOOK_STRICT === "1";

  if (!config) {
    fail(
      "Skipping: set PIM_AGENT_ID, PIM_SCOPE, and either PIM_POD_ID or PIM_PROJECT_ID (or .pim.json).",
      strict,
    );
    return;
  }

  let subject: string;
  let body: string;
  let stat: string;
  let files: string;
  let sha: string;
  try {
    subject = git(["log", "-1", "--pretty=%s"]);
    body = git(["log", "-1", "--pretty=%b"]);
    stat = git(["show", "-1", "--stat", "--format="]);
    files = git(["diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD"]);
    sha = git(["rev-parse", "HEAD"]);
  } catch (e) {
    fail(`git failed: ${e instanceof Error ? e.message : e}`, strict);
    return;
  }

  const fileList = files
    .split("\n")
    .map((f) => f.trim())
    .filter(Boolean)
    .slice(0, 80);

  const artifacts: Array<{ type: string; path?: string; sha?: string }> = [
    { type: "commit", sha },
    ...fileList.map((path) => ({ type: "change", path })),
  ];

  const details =
    [body && `Commit body:\n${body}`, stat && `Stat:\n${stat}`]
      .filter(Boolean)
      .join("\n\n") || "(no extra details)";

  const url =
    config.mode === "pod"
      ? `${config.serverUrl}/api/pods/${encodeURIComponent(config.podId!)}/context-updates`
      : `${config.serverUrl}/api/projects/${encodeURIComponent(config.projectId!)}/context-updates`;
  const res = await fetch(url, {
    method: "POST",
    headers: orgHeaders(config),
    body: JSON.stringify({
      agent_id: config.agentId,
      scope: config.scope,
      type: "progress",
      summary: subject.slice(0, 500),
      details: details.slice(0, 8000),
      status: "completed",
      artifacts,
      blocks: [],
      blocked_by: [],
      needs_input_from: [],
      source: "git-hook",
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    fail(`PIM POST failed ${res.status}: ${text}`, strict);
    return;
  }

  const label = config.mode === "pod" ? config.podId : config.projectId;
  console.error(`[pim-hook] Reported commit to PIM (${label})`);
}

async function postRewrite(): Promise<void> {
  const config = resolveConfig();
  const strict = process.env.PIM_HOOK_STRICT === "1";

  if (!config) {
    fail(
      "Skipping: set PIM_AGENT_ID, PIM_SCOPE, and either PIM_POD_ID or PIM_PROJECT_ID (or .pim.json).",
      strict,
    );
    return;
  }

  const rewriteKind = process.argv[2] ?? "unknown";

  let stdinData = "";
  try {
    stdinData = readFileSync(0, "utf-8");
  } catch {
    stdinData = "";
  }

  const details = [
    `Rewrite kind: ${rewriteKind}`,
    stdinData ? `Mappings:\n${stdinData.trim()}` : "(no stdin)",
  ].join("\n\n");

  const url =
    config.mode === "pod"
      ? `${config.serverUrl}/api/pods/${encodeURIComponent(config.podId!)}/context-updates`
      : `${config.serverUrl}/api/projects/${encodeURIComponent(config.projectId!)}/context-updates`;
  const res = await fetch(url, {
    method: "POST",
    headers: orgHeaders(config),
    body: JSON.stringify({
      agent_id: config.agentId,
      scope: config.scope,
      type: "progress",
      summary: `Git history rewritten (${rewriteKind})`,
      details: details.slice(0, 8000),
      status: "completed",
      artifacts: [],
      blocks: [],
      blocked_by: [],
      needs_input_from: [],
      source: "git-hook",
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    fail(`PIM POST failed ${res.status}: ${text}`, strict);
    return;
  }

  const label = config.mode === "pod" ? config.podId : config.projectId;
  console.error(`[pim-hook] Reported post-rewrite to PIM (${label})`);
}

const kind = process.env.PIM_HOOK_KIND ?? "";

async function main(): Promise<void> {
  if (kind === "post-commit") {
    await postCommit();
    return;
  }
  if (kind === "post-rewrite") {
    await postRewrite();
    return;
  }
  console.error("[pim-hook] PIM_HOOK_KIND must be post-commit or post-rewrite");
  process.exit(1);
}

main().catch((e) => {
  console.error("[pim-hook]", e);
  process.exit(process.env.PIM_HOOK_STRICT === "1" ? 1 : 0);
});
