/**
 * Stage 2 of the T3-events sandbox seeding pipeline.
 *
 * Reads a candidates JSON (output of mine-repo.ts), runs each candidate through
 * Claude Haiku 4.5 with a classification prompt, and emits a "classified.json"
 * containing only the items the model judged to be durable, code-actionable
 * org learnings. Each kept item is normalized to the
 * /api/knowledge/nodes POST shape:
 *
 *   { type, summary, details, domains, confidence_score, source_label }
 *
 * Dropped items are recorded in the same file under `rejected` with the
 * model's stated reason, so the prompt can be tuned over time without losing
 * the audit trail.
 *
 * Why a classifier and not bulk import: the KG is a curated store, not a
 * search index (CLAUDE.md, ARCHITECTURE_OVERVIEW.md). Most merged PRs are
 * "bump version", "fix typo", or feature work whose lesson is already encoded
 * in the resulting code. The classifier's job is to find the small fraction
 * that record a non-obvious decision, anti-pattern, or convention worth
 * surfacing to future agents who never touched the original PR.
 *
 * Usage:
 *   pnpm exec tsx scripts/classify-candidates.ts \
 *     --in scripts/candidates/adobecom-EMC.json \
 *     --out scripts/classified/adobecom-EMC.json
 *
 *   pnpm exec tsx scripts/classify-candidates.ts --in <file> --out <file> --concurrency 4
 */

import "../src/load-env.js";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

interface Args {
  in: string;
  out: string;
  model: string;
  region: string;
  concurrency: number;
  maxCandidates: number | null;
  dryRun: boolean;
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

interface ClassifiedNode {
  type: "decision" | "pattern" | "anti_pattern" | "resolved_conflict" | "scope_insight";
  summary: string;
  details: string;
  domains: string[];
  confidence_score: number;
  source_label: string;
  source_url: string;
  source_kind: "pr" | "doc";
}

interface RejectedItem {
  source_label: string;
  source_url: string;
  reason: string;
}

function parseArgs(argv: string[]): Args {
  const args: Partial<Args> = {
    // Default to whatever the eval pipeline calls "fast" — Haiku 4.5 right now.
    model: process.env.BEDROCK_MODEL_FAST ?? "us.anthropic.claude-haiku-4-5-20251001-v1:0",
    region: process.env.AWS_REGION ?? "us-west-2",
    concurrency: 4,
    maxCandidates: null,
    dryRun: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = argv[i + 1];
    switch (a) {
      case "--in": args.in = next; i++; break;
      case "--out": args.out = next; i++; break;
      case "--model": args.model = next; i++; break;
      case "--region": args.region = next; i++; break;
      case "--concurrency": args.concurrency = Number(next); i++; break;
      case "--max": args.maxCandidates = Number(next); i++; break;
      case "--dry-run": args.dryRun = true; break;
      default:
        if (a.startsWith("--")) throw new Error(`Unknown flag: ${a}`);
    }
  }
  if (!args.in || !args.out) throw new Error("--in and --out are required");
  return args as Args;
}

const SYSTEM_PROMPT = `You are an org-knowledge curator for the Adobe T3 Events platform (the events-on-Milo stack: EMC + event-libs frontends, events-service-platform + events-service-layer backends).

You decide whether a given pull-request or doc excerpt records a *durable, code-actionable learning* that a future agent (AI or human) who has never seen this repo would benefit from in the prompt.

KEEP if the excerpt encodes any of:
- A decision (e.g. "we picked X over Y because Z")
- A pattern / convention (e.g. "all ESP PUTs go through prepareEsp*PutPayload helpers")
- An anti-pattern (e.g. "do not spread the GET response into a PUT body")
- A non-obvious contract or invariant (e.g. an API field shape, a server-side validation rule)
- A resolved cross-team conflict
- A scope-shaping insight (e.g. "this service owns X but not Y")

DROP if the excerpt is:
- Version bumps, dependency updates, formatting/lint
- Pure feature work whose lesson lives in the resulting code (no decision narrative)
- Internal release notes / changelogs
- README boilerplate ("how to clone", "how to npm install")
- Single-sentence PR bodies, even if technical
- Anything that needs the reader to already know the codebase to be useful

OUTPUT FORMAT — return STRICT JSON, no markdown fence:

If KEEP:
{"keep": true,
 "type": "decision" | "pattern" | "anti_pattern" | "resolved_conflict" | "scope_insight",
 "summary": "<one sentence, <=500 chars, self-contained — name the contract/decision/anti-pattern by what it is, not by 'this PR did X'>",
 "details": "<2-5 sentences, >=30 chars, including code-level specifics (function names, file paths, API endpoints, field names) so a future agent has actionable detail. Write as durable guidance, not as commentary on this PR.>",
 "domains": ["frontend" | "backend" | "infra" | "test" | "design" | "docs"],
 "confidence_score": 0.6 to 0.95}

If DROP:
{"keep": false, "reason": "<one sentence>"}

Defaults to use when in doubt:
- confidence_score 0.7 for routine PR-derived learnings, 0.85 for explicit ADRs or design docs, 0.9+ only when the excerpt explicitly states a contract / OpenAPI constraint.
- Lean toward DROP. False positives pollute the KG. Aim for <20% keep rate on PRs and <40% on docs.`;

function candidateText(c: Candidate): { label: string; url: string; payload: string } {
  if (c.kind === "pr") {
    return {
      label: `${c.host}/${c.repo}/pull/${c.number}`,
      url: c.url,
      payload: [
        `# PR #${c.number} — ${c.title}`,
        `Repo: ${c.repo}  Author: ${c.author ?? "?"}  Merged: ${c.merged_at}`,
        c.labels.length > 0 ? `Labels: ${c.labels.join(", ")}` : "",
        c.changed_files.length > 0 ? `Files: ${c.changed_files.slice(0, 20).join(", ")}${c.changed_files.length > 20 ? "…" : ""}` : "",
        "",
        c.body,
      ]
        .filter(Boolean)
        .join("\n"),
    };
  }
  return {
    label: `${c.host}/${c.repo}/doc:${c.path}`,
    url: c.url,
    payload: [
      `# Doc: ${c.path}`,
      `Repo: ${c.repo}`,
      "",
      c.content.slice(0, 8000),
    ].join("\n"),
  };
}

interface BedrockResp {
  output?: { message?: { content?: Array<{ text?: string }> } };
}

function getBedrockToken(): string {
  const token = process.env.AWS_BEARER_TOKEN_BEDROCK;
  if (!token) {
    throw new Error(
      "AWS_BEARER_TOKEN_BEDROCK is required (same token the eval runners use). Set it in repo .env.",
    );
  }
  return token;
}

interface ClassifyResult {
  kept?: ClassifiedNode;
  rejected?: RejectedItem;
  error?: string;
}

async function classifyOne(
  token: string,
  region: string,
  model: string,
  c: Candidate,
): Promise<ClassifyResult> {
  const { label, url, payload } = candidateText(c);
  const url_ = `https://bedrock-runtime.${region}.amazonaws.com/model/${encodeURIComponent(model)}/converse`;
  try {
    const body = {
      system: [
        { text: SYSTEM_PROMPT },
        { cachePoint: { type: "default" } },
      ],
      messages: [{ role: "user", content: [{ text: payload }] }],
      inferenceConfig: { maxTokens: 800, temperature: 0 },
    };
    const resp = await fetch(url_, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
    if (!resp.ok) {
      const errBody = await resp.text().catch(() => "");
      return { error: `bedrock ${resp.status}: ${errBody.slice(0, 200)}` };
    }
    const data = (await resp.json()) as BedrockResp;
    const text = (data.output?.message?.content?.[0]?.text ?? "").trim();
    let parsed: {
      keep?: boolean;
      type?: ClassifiedNode["type"];
      summary?: string;
      details?: string;
      domains?: string[];
      confidence_score?: number;
      reason?: string;
    };
    try {
      parsed = JSON.parse(text);
    } catch {
      const m = text.match(/\{[\s\S]*\}/);
      if (!m) return { error: `unparseable: ${text.slice(0, 200)}` };
      parsed = JSON.parse(m[0]);
    }
    if (!parsed.keep) {
      return { rejected: { source_label: label, source_url: url, reason: parsed.reason ?? "(no reason)" } };
    }
    if (!parsed.type || !parsed.summary || !parsed.details || !parsed.domains) {
      return { error: `keep=true but missing fields: ${JSON.stringify(parsed).slice(0, 200)}` };
    }
    if (parsed.summary.length < 10 || parsed.summary.length > 500) {
      return { error: `summary length out of range (${parsed.summary.length})` };
    }
    if (parsed.details.length < 30) {
      return { error: `details too short (${parsed.details.length})` };
    }
    return {
      kept: {
        type: parsed.type,
        summary: parsed.summary,
        details: parsed.details,
        domains: parsed.domains,
        confidence_score: parsed.confidence_score ?? 0.7,
        source_label: label,
        source_url: url,
        source_kind: c.kind,
      },
    };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

async function runWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, i: number) => Promise<R>,
  onProgress?: (done: number, total: number) => void,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  let done = 0;
  async function worker(): Promise<void> {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
      done++;
      onProgress?.(done, items.length);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const raw = JSON.parse(await readFile(args.in, "utf8")) as {
    repo: string;
    host: string;
    candidates: Candidate[];
  };
  let candidates = raw.candidates;
  if (args.maxCandidates) candidates = candidates.slice(0, args.maxCandidates);
  console.log(`[classify] in=${args.in} candidates=${candidates.length} model=${args.model} concurrency=${args.concurrency}`);

  if (args.dryRun) {
    console.log("[classify] dry-run: not calling LLM");
    return;
  }

  const token = getBedrockToken();
  const results = await runWithConcurrency(
    candidates,
    args.concurrency,
    (c) => classifyOne(token, args.region, args.model, c),
    (d, t) => {
      if (d % 10 === 0 || d === t) process.stdout.write(`\r[classify] ${d}/${t}`);
    },
  );
  process.stdout.write("\n");

  const kept: ClassifiedNode[] = [];
  const rejected: RejectedItem[] = [];
  const errors: Array<{ source_label: string; error: string }> = [];
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const { label } = candidateText(candidates[i]);
    if (r.kept) kept.push(r.kept);
    else if (r.rejected) rejected.push(r.rejected);
    else if (r.error) errors.push({ source_label: label, error: r.error });
  }

  await mkdir(dirname(args.out), { recursive: true });
  await writeFile(
    args.out,
    JSON.stringify(
      {
        repo: raw.repo,
        host: raw.host,
        classified_at: new Date().toISOString(),
        model: args.model,
        kept,
        rejected,
        errors,
      },
      null,
      2,
    ),
  );
  console.log(`[classify] wrote ${args.out} — kept=${kept.length} rejected=${rejected.length} errors=${errors.length}`);
}

main().catch((err) => {
  console.error("[classify] error:", err instanceof Error ? err.message : err);
  process.exit(1);
});
