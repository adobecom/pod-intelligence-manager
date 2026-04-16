/**
 * Invoked by git post-commit / post-rewrite hooks (see hooks.ts).
 * Uses raw fetch — keep dependencies minimal for fast hook execution.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const SCOPES = new Set(["frontend", "backend", "design", "qa", "infra", "pm"]);

function git(args: string[]): string {
  const r = spawnSync("git", args, { encoding: "utf-8" });
  if (r.error) throw r.error;
  return (r.stdout ?? "").trim();
}

function fail(msg: string, strict: boolean): void {
  console.error(`[council-hook] ${msg}`);
  if (strict) process.exit(1);
  process.exit(0);
}

async function postCommit(): Promise<void> {
  const baseUrl = (process.env.COUNCIL_SERVER_URL ?? "http://localhost:4000").replace(/\/$/, "");
  const podId = process.env.COUNCIL_POD_ID?.trim();
  const agentId = process.env.COUNCIL_AGENT_ID?.trim();
  const scope = process.env.COUNCIL_SCOPE?.trim();
  const strict = process.env.COUNCIL_HOOK_STRICT === "1";

  if (!podId || !agentId || !scope) {
    fail(
      "Skipping: set COUNCIL_SERVER_URL, COUNCIL_POD_ID, COUNCIL_AGENT_ID, COUNCIL_SCOPE for Council git hooks.",
      strict,
    );
    return;
  }
  if (!SCOPES.has(scope)) {
    fail(`Invalid COUNCIL_SCOPE "${scope}".`, strict);
    return;
  }

  let subject: string;
  let body: string;
  let stat: string;
  let files: string;
  try {
    subject = git(["log", "-1", "--pretty=%s"]);
    body = git(["log", "-1", "--pretty=%b"]);
    stat = git(["show", "-1", "--stat", "--format="]);
    files = git(["diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD"]);
  } catch (e) {
    fail(`git failed: ${e instanceof Error ? e.message : e}`, strict);
    return;
  }

  const fileList = files
    .split("\n")
    .map((f) => f.trim())
    .filter(Boolean)
    .slice(0, 80);

  const artifacts = fileList.map((path) => ({ type: "change", path }));

  const details = [body && `Commit body:\n${body}`, stat && `Stat:\n${stat}`].filter(Boolean).join("\n\n") || "(no extra details)";

  const url = `${baseUrl}/api/pods/${encodeURIComponent(podId)}/context-updates`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      agent_id: agentId,
      scope,
      type: "progress",
      summary: subject.slice(0, 500),
      details: details.slice(0, 8000),
      status: "completed",
      artifacts,
      blocks: [],
      blocked_by: [],
      needs_input_from: [],
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    fail(`Council POST failed ${res.status}: ${text}`, strict);
    return;
  }

  console.error(`[council-hook] Reported commit to Council (${podId})`);
}

async function postRewrite(): Promise<void> {
  const baseUrl = (process.env.COUNCIL_SERVER_URL ?? "http://localhost:4000").replace(/\/$/, "");
  const podId = process.env.COUNCIL_POD_ID?.trim();
  const agentId = process.env.COUNCIL_AGENT_ID?.trim();
  const scope = process.env.COUNCIL_SCOPE?.trim();
  const strict = process.env.COUNCIL_HOOK_STRICT === "1";

  if (!podId || !agentId || !scope) {
    fail(
      "Skipping: set COUNCIL_SERVER_URL, COUNCIL_POD_ID, COUNCIL_AGENT_ID, COUNCIL_SCOPE for Council git hooks.",
      strict,
    );
    return;
  }
  if (!SCOPES.has(scope)) {
    fail(`Invalid COUNCIL_SCOPE "${scope}".`, strict);
    return;
  }

  const rewriteKind = process.argv[2] ?? "unknown";
  let stdinData = "";
  try {
    stdinData = readFileSync(0, "utf-8");
  } catch {
    stdinData = "";
  }

  const details = [`Rewrite kind: ${rewriteKind}`, stdinData ? `Mappings:\n${stdinData.trim()}` : "(no stdin)"].join("\n\n");

  const url = `${baseUrl}/api/pods/${encodeURIComponent(podId)}/context-updates`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      agent_id: agentId,
      scope,
      type: "progress",
      summary: `Git history rewritten (${rewriteKind})`,
      details: details.slice(0, 8000),
      status: "completed",
      artifacts: [],
      blocks: [],
      blocked_by: [],
      needs_input_from: [],
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    fail(`Council POST failed ${res.status}: ${text}`, strict);
    return;
  }

  console.error(`[council-hook] Reported post-rewrite to Council (${podId})`);
}

const kind = process.env.COUNCIL_HOOK_KIND ?? "";

async function main(): Promise<void> {
  if (kind === "post-commit") {
    await postCommit();
    return;
  }
  if (kind === "post-rewrite") {
    await postRewrite();
    return;
  }
  console.error("[council-hook] COUNCIL_HOOK_KIND must be post-commit or post-rewrite");
  process.exit(1);
}

main().catch((e) => {
  console.error("[council-hook]", e);
  process.exit(process.env.COUNCIL_HOOK_STRICT === "1" ? 1 : 0);
});
