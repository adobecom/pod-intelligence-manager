/**
 * Stage 1 of the T3-events sandbox seeding pipeline.
 *
 * Walks a single repo via its GitHub-compatible API (works against github.com
 * and Adobe's git.corp Enterprise instance) and emits a JSON file of raw
 * "candidate learnings": merged PR descriptions over a length threshold plus
 * every Markdown file under the repo root. Output is intentionally noisy — the
 * next stage (classify-candidates.ts) is the deliberate curation gate that
 * decides which of these are real durable learnings.
 *
 * Auth: reads the PAT from $GITHUB_TOKEN when --host=github.com (default) and
 * from $GITCORP_TOKEN when --host=git.corp.adobe.com. Tokens are only used in
 * the Authorization header on outbound requests; they are never written to
 * disk or echoed.
 *
 * Usage:
 *   pnpm exec tsx scripts/mine-repo.ts \
 *     --repo adobecom/EMC \
 *     --out scripts/candidates/adobecom-EMC.json
 *
 *   pnpm exec tsx scripts/mine-repo.ts \
 *     --repo wcms/events-service-platform \
 *     --host git.corp.adobe.com \
 *     --out scripts/candidates/git-corp-wcms-events-service-platform.json
 *
 * Flags:
 *   --repo <owner/name>          Required. Repository slug.
 *   --host <hostname>            Default github.com. Use git.corp.adobe.com for internal.
 *   --out <path>                 Default scripts/candidates/<host>-<owner>-<name>.json.
 *   --since <ISO date>           Only consider PRs merged on/after this date. Default: 2 years ago.
 *   --max-prs <n>                Cap the number of PRs fetched. Default: 500.
 *   --min-body-chars <n>         Skip PRs whose description is shorter than this. Default: 200.
 *   --include-docs               (default on) Mine *.md files. Pass --no-include-docs to skip.
 *   --include-prs                (default on) Mine merged PRs. Pass --no-include-prs to skip.
 */

import "../src/load-env.js";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

interface Args {
  repo: string;
  host: string;
  out: string;
  since: string;
  maxPrs: number;
  minBodyChars: number;
  includeDocs: boolean;
  includePrs: boolean;
}

interface PrCandidate {
  kind: "pr";
  repo: string;
  host: string;
  number: number;
  title: string;
  body: string;
  merged_at: string;
  author: string | null;
  url: string;
  labels: string[];
  changed_files: string[];
}

interface DocCandidate {
  kind: "doc";
  repo: string;
  host: string;
  path: string;
  content: string;
  url: string;
}

type Candidate = PrCandidate | DocCandidate;

function parseArgs(argv: string[]): Args {
  const args: Partial<Args> = {
    host: "github.com",
    since: new Date(Date.now() - 2 * 365 * 24 * 3600 * 1000).toISOString().slice(0, 10),
    maxPrs: 500,
    minBodyChars: 200,
    includeDocs: true,
    includePrs: true,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = argv[i + 1];
    switch (a) {
      case "--repo": args.repo = next; i++; break;
      case "--host": args.host = next; i++; break;
      case "--out": args.out = next; i++; break;
      case "--since": args.since = next; i++; break;
      case "--max-prs": args.maxPrs = Number(next); i++; break;
      case "--min-body-chars": args.minBodyChars = Number(next); i++; break;
      case "--include-docs": args.includeDocs = true; break;
      case "--no-include-docs": args.includeDocs = false; break;
      case "--include-prs": args.includePrs = true; break;
      case "--no-include-prs": args.includePrs = false; break;
      default:
        if (a.startsWith("--")) throw new Error(`Unknown flag: ${a}`);
    }
  }
  if (!args.repo) throw new Error("--repo owner/name is required");
  if (!args.out) {
    const safe = `${args.host}-${args.repo}`.replace(/[/.]/g, "-");
    args.out = `scripts/candidates/${safe}.json`;
  }
  return args as Args;
}

function apiBase(host: string): string {
  // GitHub.com: https://api.github.com
  // GitHub Enterprise: https://<host>/api/v3
  return host === "github.com" ? "https://api.github.com" : `https://${host}/api/v3`;
}

function token(host: string): string {
  const envName = host === "github.com" ? "GITHUB_TOKEN" : "GITCORP_TOKEN";
  const t = process.env[envName];
  if (!t) {
    throw new Error(
      `Missing $${envName} for host ${host}. Set it in your shell or in packages/eval/.env (not committed).`,
    );
  }
  return t;
}

async function ghFetch(url: string, host: string, init?: RequestInit): Promise<Response> {
  return fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${token(host)}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "pim-eval-mine-repo",
      ...(init?.headers ?? {}),
    },
  });
}

async function ghJson<T>(url: string, host: string): Promise<T> {
  const res = await ghFetch(url, host);
  if (!res.ok) {
    throw new Error(`GET ${url} -> ${res.status} ${res.statusText}: ${await res.text()}`);
  }
  return res.json() as Promise<T>;
}

interface PrListItem {
  number: number;
  title: string;
  body: string | null;
  merged_at: string | null;
  user: { login: string } | null;
  html_url: string;
  labels: Array<{ name: string }>;
  pull_request?: { merged_at?: string | null };
}

async function fetchMergedPrs(args: Args): Promise<PrCandidate[]> {
  const out: PrCandidate[] = [];
  const sinceTs = new Date(args.since).getTime();
  let page = 1;
  const perPage = 100;
  while (out.length < args.maxPrs) {
    const url = `${apiBase(args.host)}/repos/${args.repo}/pulls?state=closed&sort=updated&direction=desc&per_page=${perPage}&page=${page}`;
    const items = await ghJson<PrListItem[]>(url, args.host);
    if (items.length === 0) break;
    let pageHadFresh = false;
    for (const pr of items) {
      if (!pr.merged_at) continue;
      const ts = new Date(pr.merged_at).getTime();
      if (ts < sinceTs) continue;
      pageHadFresh = true;
      const body = (pr.body ?? "").trim();
      if (body.length < args.minBodyChars) continue;
      const files = await fetchPrFiles(args, pr.number);
      out.push({
        kind: "pr",
        repo: args.repo,
        host: args.host,
        number: pr.number,
        title: pr.title,
        body,
        merged_at: pr.merged_at,
        author: pr.user?.login ?? null,
        url: pr.html_url,
        labels: (pr.labels ?? []).map((l) => l.name),
        changed_files: files,
      });
      if (out.length >= args.maxPrs) break;
    }
    if (!pageHadFresh) break;
    page++;
  }
  return out;
}

async function fetchPrFiles(args: Args, prNumber: number): Promise<string[]> {
  const url = `${apiBase(args.host)}/repos/${args.repo}/pulls/${prNumber}/files?per_page=100`;
  try {
    const items = await ghJson<Array<{ filename: string }>>(url, args.host);
    return items.map((f) => f.filename);
  } catch {
    return [];
  }
}

interface TreeNode {
  path: string;
  type: "blob" | "tree";
  sha: string;
}

async function fetchMarkdownDocs(args: Args): Promise<DocCandidate[]> {
  const repoInfo = await ghJson<{ default_branch: string }>(
    `${apiBase(args.host)}/repos/${args.repo}`,
    args.host,
  );
  const tree = await ghJson<{ tree: TreeNode[]; truncated: boolean }>(
    `${apiBase(args.host)}/repos/${args.repo}/git/trees/${repoInfo.default_branch}?recursive=1`,
    args.host,
  );
  const docs: DocCandidate[] = [];
  for (const node of tree.tree) {
    if (node.type !== "blob") continue;
    if (!/\.(md|mdx)$/i.test(node.path)) continue;
    if (node.path.startsWith("node_modules/")) continue;
    // Vendored AI agent references (Spectrum 2 component docs copied into repos
    // for Claude Code), and per-repo Claude Code agent/command definitions, are
    // not durable EMC learnings. Skip them at the mining stage to save tokens.
    if (node.path.startsWith(".agents/")) continue;
    if (node.path.startsWith(".claude/")) continue;
    if (/CHANGELOG/i.test(node.path)) continue;
    const raw = await fetchRawFile(args, repoInfo.default_branch, node.path);
    if (!raw || raw.trim().length < 200) continue;
    docs.push({
      kind: "doc",
      repo: args.repo,
      host: args.host,
      path: node.path,
      content: raw,
      url: `https://${args.host}/${args.repo}/blob/${repoInfo.default_branch}/${node.path}`,
    });
  }
  return docs;
}

async function fetchRawFile(args: Args, ref: string, path: string): Promise<string | null> {
  const url = `${apiBase(args.host)}/repos/${args.repo}/contents/${encodeURI(path)}?ref=${ref}`;
  const res = await ghFetch(url, args.host, { headers: { Accept: "application/vnd.github.raw" } });
  if (!res.ok) return null;
  return res.text();
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  console.log(
    `[mine] repo=${args.repo} host=${args.host} since=${args.since} maxPrs=${args.maxPrs} minBody=${args.minBodyChars} prs=${args.includePrs} docs=${args.includeDocs}`,
  );
  const candidates: Candidate[] = [];
  if (args.includePrs) {
    const prs = await fetchMergedPrs(args);
    console.log(`[mine] PRs kept: ${prs.length}`);
    candidates.push(...prs);
  }
  if (args.includeDocs) {
    const docs = await fetchMarkdownDocs(args);
    console.log(`[mine] docs kept: ${docs.length}`);
    candidates.push(...docs);
  }
  await mkdir(dirname(args.out), { recursive: true });
  await writeFile(
    args.out,
    JSON.stringify({ repo: args.repo, host: args.host, mined_at: new Date().toISOString(), candidates }, null, 2),
  );
  console.log(`[mine] wrote ${args.out} (${candidates.length} candidates)`);
}

main().catch((err) => {
  console.error("[mine] error:", err instanceof Error ? err.message : err);
  process.exit(1);
});
