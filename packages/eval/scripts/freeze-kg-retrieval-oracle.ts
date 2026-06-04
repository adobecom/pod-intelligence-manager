/**
 * Freeze a live KG graph into the offline retrieval oracle used by the server
 * golden test. Existing v2 review labels are preserved by default.
 *
 *   pnpm --filter @pim/eval freeze-kg-retrieval-oracle
 */
import "../src/load-env.js";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { pods as demoPods } from "@pim/shared";
import type { KnowledgeGraph, KnowledgeNode, KnowledgeQueryFilters, KnowledgeQueryResult } from "@pim/shared";
import { assertSecurePermissions, ensureFreshToken, loadCredentials } from "@pim/shared/auth";
import { ALL_TASKS } from "../src/tasks/index.js";
import type { Task } from "../src/tasks/types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const DEFAULT_OUT_PATH = join(
  __dirname,
  "..",
  "..",
  "server",
  "src",
  "services",
  "__fixtures__",
  "kg-retrieval-oracle.json",
);
const DEFAULT_REPORT_PATH = join(__dirname, "..", "KG_RETRIEVAL_ORACLE_CANDIDATES.md");
const DEFAULT_API_BASE = "https://d1ygncl0yqo6sv.cloudfront.net";
const DEFAULT_ORG_SLUG = "emc-sandbox";
const DEFAULT_MAX_TOKENS = 1_000_000;
const DEFAULT_EMBEDDING_DIMENSIONS = 512;
const VALID_EMBEDDING_DIMENSIONS = new Set([256, 512, 1024]);

interface Args {
  outPath: string;
  reportPath: string;
  apiBase: string;
  orgSlug: string;
  fixtureOrgId: string;
  maxTokens: number;
  taskIds: Set<string> | null;
  acceptCurrentResults: boolean;
  help: boolean;
}

interface OracleCase {
  taskId: string;
  podId: string;
  description?: string;
  filters: KnowledgeQueryFilters;
  queryText: string;
  queryEmbedding: number[];
  mustIncludeNodeIds: string[];
  shouldIncludeNodeIds?: string[];
  mustNotIncludeNodeIds?: string[];
  reviewedNoRequiredNodes?: boolean;
  negativeControl?: boolean;
  expectedMaxReturned?: number;
  maxRequiredRank?: number;
  metrics?: {
    minRecallAtBudget?: number;
    minMrr?: number;
    minPrecisionAt3?: number;
    minPrecisionAt5?: number;
    minPrecisionAt10?: number;
  };
}

interface RetrievalOracleFixture {
  formatVersion: 2;
  orgId: string;
  sourceOrgSlug: string;
  generatedAt: string;
  embedding: {
    provider: "bedrock";
    model: string;
    dimensions: number;
    normalized: true;
  };
  tuning: {
    minQuerySimilarity: number;
    recencyDecayDays: number;
    samePodDedupThreshold: number;
    crossPodDedupThreshold: number;
  };
  graph: KnowledgeGraph;
  cases: OracleCase[];
}

interface QueryResponse extends KnowledgeQueryResult {
  nodes: KnowledgeNode[];
}

function usage(): string {
  return [
    "Usage: pnpm --filter @pim/eval freeze-kg-retrieval-oracle [options]",
    "",
    "Options:",
    "  --out=<path>                 Fixture path to write",
    "  --report=<path>              Markdown candidate report path to write",
    "  --api-base=<url>             PIM API base URL",
    "  --org=<slug>                 PIM org slug",
    "  --fixture-org-id=<id>        Org id stored inside the frozen fixture graph",
    "  --task=<id>                  Include only one existing case id; repeatable or comma-separated",
    "  --max-tokens=<n>             Query token budget for live probing",
    "  --accept-current-results     Replace mustIncludeNodeIds with current live returned ids",
    "  --help                       Print this help",
  ].join("\n");
}

function parseArgs(argv: string[]): Args {
  const taskIds = new Set<string>();
  const args: Args = {
    outPath: DEFAULT_OUT_PATH,
    reportPath: DEFAULT_REPORT_PATH,
    apiBase: process.env.EVAL_PIM_BASE_URL?.replace(/\/+$/, "") ?? DEFAULT_API_BASE,
    orgSlug: process.env.EVAL_PIM_ORG_SLUG ?? DEFAULT_ORG_SLUG,
    fixtureOrgId: "kg-recall-golden",
    maxTokens: DEFAULT_MAX_TOKENS,
    taskIds: null,
    acceptCurrentResults: false,
    help: false,
  };

  for (const arg of argv) {
    if (arg === "--") continue;
    if (arg === "--help" || arg === "-h") {
      args.help = true;
    } else if (arg === "--accept-current-results") {
      args.acceptCurrentResults = true;
    } else if (arg.startsWith("--out=")) {
      args.outPath = resolve(arg.slice("--out=".length));
    } else if (arg.startsWith("--report=")) {
      args.reportPath = resolve(arg.slice("--report=".length));
    } else if (arg.startsWith("--api-base=")) {
      args.apiBase = arg.slice("--api-base=".length).replace(/\/+$/, "");
    } else if (arg.startsWith("--org=")) {
      args.orgSlug = arg.slice("--org=".length);
    } else if (arg.startsWith("--fixture-org-id=")) {
      args.fixtureOrgId = arg.slice("--fixture-org-id=".length);
    } else if (arg.startsWith("--task=")) {
      for (const id of arg.slice("--task=".length).split(",")) {
        if (id.trim()) taskIds.add(id.trim());
      }
    } else if (arg.startsWith("--max-tokens=")) {
      const parsed = Number(arg.slice("--max-tokens=".length));
      if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`Invalid --max-tokens: ${arg}`);
      args.maxTokens = parsed;
    } else {
      throw new Error(`Unknown argument: ${arg}\n\n${usage()}`);
    }
  }

  args.taskIds = taskIds.size > 0 ? taskIds : null;
  return args;
}

function compactForKgQuery(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, 3500);
}

function buildTaskKgQuery(task: Task): string {
  const promptWithoutCode = task.prompt
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/\n# Output[\s\S]*$/i, "\n")
    .replace(/\n# Current source[\s\S]*$/i, "\n");
  return compactForKgQuery(
    [
      `Task: ${task.id}`,
      task.tags?.length ? `Tags: ${task.tags.join(", ")}` : "",
      task.expectedSignals?.length ? `Expected signals: ${task.expectedSignals.join(", ")}` : "",
      promptWithoutCode,
    ].filter(Boolean).join("\n"),
  );
}

function taskDescription(task: Task): string {
  return compactForKgQuery(task.prompt).slice(0, 220);
}

function taskFilters(task: Task): KnowledgeQueryFilters {
  const pod = demoPods[task.podId] as { areas?: Array<{ scope: string }>; project_id?: string } | undefined;
  const scopes = Array.from(new Set((pod?.areas ?? []).map((area) => area.scope)));
  const domains = scopes.length > 0 ? scopes : ["frontend", "backend"];
  const projectId = pod?.project_id?.trim();
  return {
    domains,
    ...(projectId ? { include_project_id: projectId } : {}),
  };
}

function embeddingDimensions(): number {
  const raw = Number(process.env.EMBEDDING_DIMENSIONS ?? DEFAULT_EMBEDDING_DIMENSIONS);
  return VALID_EMBEDDING_DIMENSIONS.has(raw) ? raw : DEFAULT_EMBEDDING_DIMENSIONS;
}

async function generateEmbedding(text: string, dimensions: number): Promise<number[]> {
  const region = process.env.AWS_REGION;
  const token = process.env.AWS_BEARER_TOKEN_BEDROCK;
  if (!region || !token) {
    throw new Error("AWS_REGION and AWS_BEARER_TOKEN_BEDROCK are required to create missing query embeddings.");
  }

  const url = `https://bedrock-runtime.${region}.amazonaws.com/model/amazon.titan-embed-text-v2:0/invoke`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ inputText: text, dimensions, normalize: true }),
  });
  if (!res.ok) throw new Error(`Bedrock embedding request failed: ${res.status} ${res.statusText} ${await res.text()}`);
  const body = (await res.json()) as { embedding?: number[] };
  if (!body.embedding?.length) throw new Error("Bedrock embedding response did not include an embedding.");
  return body.embedding;
}

async function authHeaders(orgSlug: string): Promise<Record<string, string>> {
  assertSecurePermissions();
  const creds = loadCredentials();
  if (!creds) throw new Error("No credentials at ~/.pim/credentials.json. Run `pim login` first.");
  const fresh = await ensureFreshToken(creds);
  return {
    Authorization: `Bearer ${fresh.access_token}`,
    "X-Pim-Org": orgSlug,
    "Content-Type": "application/json",
  };
}

async function fetchJson<T>(url: string, init: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) throw new Error(`${init.method ?? "GET"} ${url} failed: ${res.status} ${await res.text()}`);
  return (await res.json()) as T;
}

async function loadExistingOracle(path: string): Promise<RetrievalOracleFixture | null> {
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw) as RetrievalOracleFixture;
    return parsed.formatVersion === 2 ? parsed : null;
  } catch (err) {
    if (err instanceof Error && "code" in err && err.code === "ENOENT") return null;
    throw err;
  }
}

function casesFromCurrentTasks(): OracleCase[] {
  return ALL_TASKS.map((task) => ({
    taskId: task.id,
    podId: task.podId,
    description: taskDescription(task),
    filters: taskFilters(task),
    queryText: buildTaskKgQuery(task),
    queryEmbedding: [],
    mustIncludeNodeIds: [],
    shouldIncludeNodeIds: [],
    mustNotIncludeNodeIds: [],
  }));
}

function selectedCases(existing: RetrievalOracleFixture | null, taskIds: Set<string> | null): OracleCase[] {
  const baseCases = existing?.cases.length ? existing.cases : casesFromCurrentTasks();
  const cases = taskIds ? baseCases.filter((testCase) => taskIds.has(testCase.taskId)) : baseCases;
  if (cases.length === 0) {
    throw new Error(`No oracle cases selected${taskIds ? ` for ${[...taskIds].join(", ")}` : ""}.`);
  }
  return cases;
}

function mdCell(value: string, max = 140): string {
  const clean = value.replace(/\r?\n/g, " ").replace(/\s+/g, " ").replace(/\|/g, "\\|").trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}...` : clean;
}

function buildReport(fixture: RetrievalOracleFixture, resultsByTask: Map<string, QueryResponse>): string {
  const lines: string[] = [];
  lines.push("# KG Retrieval Oracle Candidate Review");
  lines.push("");
  lines.push(`Generated: ${fixture.generatedAt}`);
  lines.push(`Source org: \`${fixture.sourceOrgSlug}\``);
  lines.push(`Frozen graph: ${fixture.graph.nodes.length} nodes, ${fixture.graph.edges.length} edges`);
  lines.push("");
  lines.push("Review flow: update v2 label fields in `kg-retrieval-oracle.json`; rerun the server retrieval golden test.");
  lines.push("");

  for (const testCase of fixture.cases) {
    const result = resultsByTask.get(testCase.taskId);
    const returned = result?.nodes ?? [];
    const labels = new Set([
      ...testCase.mustIncludeNodeIds,
      ...(testCase.shouldIncludeNodeIds ?? []),
      ...(testCase.mustNotIncludeNodeIds ?? []),
    ]);
    lines.push(`## ${testCase.taskId}`);
    lines.push("");
    lines.push(`- Pod: \`${testCase.podId}\``);
    lines.push(`- Must include: ${testCase.mustIncludeNodeIds.map((id) => `\`${id}\``).join(", ") || "(none)"}`);
    lines.push(`- Should include: ${(testCase.shouldIncludeNodeIds ?? []).map((id) => `\`${id}\``).join(", ") || "(none)"}`);
    lines.push(`- Must not include: ${(testCase.mustNotIncludeNodeIds ?? []).map((id) => `\`${id}\``).join(", ") || "(none)"}`);
    lines.push(
      `- Live query returned ${returned.length} node(s), total_matching=${result?.total_matching ?? "n/a"}, truncated=${result?.truncated ?? "n/a"}`,
    );
    lines.push("");
    lines.push("| rank | mark | node id | conf | type | domains | summary |");
    lines.push("| ---: | --- | --- | ---: | --- | --- | --- |");
    returned.slice(0, 50).forEach((node, index) => {
      const mark = testCase.mustIncludeNodeIds.includes(node.id)
        ? "must"
        : (testCase.shouldIncludeNodeIds ?? []).includes(node.id)
          ? "should"
          : (testCase.mustNotIncludeNodeIds ?? []).includes(node.id)
            ? "forbidden"
            : labels.size > 0
              ? ""
              : "candidate";
      lines.push(
        `| ${index + 1} | ${mark} | \`${node.id}\` | ${node.confidence_score.toFixed(2)} | ${node.type} | ${node.domains.join(", ")} | ${mdCell(node.summary)} |`,
      );
    });
    lines.push("");
  }

  return lines.join("\n");
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    return;
  }

  const existing = await loadExistingOracle(args.outPath);
  const dimensions = existing?.embedding.dimensions ?? embeddingDimensions();
  const headers = await authHeaders(args.orgSlug);
  const sourceCases = selectedCases(existing, args.taskIds);

  console.log(`[kg-oracle] fetching full graph from ${args.apiBase} org=${args.orgSlug}`);
  const liveGraph = await fetchJson<KnowledgeGraph>(
    `${args.apiBase}/api/knowledge/graph?include_embeddings=true`,
    { method: "GET", headers },
  );
  const graph: KnowledgeGraph = { ...liveGraph, org_id: args.fixtureOrgId };

  const cases: OracleCase[] = [];
  const resultsByTask = new Map<string, QueryResponse>();
  for (const source of sourceCases) {
    const queryEmbedding = source.queryEmbedding.length > 0
      ? source.queryEmbedding
      : await generateEmbedding(source.queryText, dimensions);
    const queryResult = await fetchJson<QueryResponse>(`${args.apiBase}/api/knowledge/query`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        filters: source.filters,
        max_tokens: args.maxTokens,
        include_details: false,
        query_text: source.queryText,
        query_embedding: queryEmbedding,
      }),
    });
    resultsByTask.set(source.taskId, queryResult);

    cases.push({
      ...source,
      queryEmbedding,
      mustIncludeNodeIds: args.acceptCurrentResults
        ? queryResult.nodes.map((node) => node.id)
        : source.mustIncludeNodeIds,
      shouldIncludeNodeIds: source.shouldIncludeNodeIds ?? [],
      mustNotIncludeNodeIds: source.mustNotIncludeNodeIds ?? [],
    });

    console.log(
      `[kg-oracle] ${source.taskId}: live=${queryResult.nodes.length} matching=${queryResult.total_matching} must=${source.mustIncludeNodeIds.length}`,
    );
  }

  const fixture: RetrievalOracleFixture = {
    formatVersion: 2,
    orgId: args.fixtureOrgId,
    sourceOrgSlug: args.orgSlug,
    generatedAt: new Date().toISOString(),
    embedding: {
      provider: "bedrock",
      model: "amazon.titan-embed-text-v2:0",
      dimensions,
      normalized: true,
    },
    tuning: existing?.tuning ?? {
      minQuerySimilarity: 0.75,
      recencyDecayDays: 90,
      samePodDedupThreshold: 0.85,
      crossPodDedupThreshold: 0.95,
    },
    graph,
    cases,
  };

  await mkdir(dirname(args.outPath), { recursive: true });
  await writeFile(args.outPath, `${JSON.stringify(fixture, null, 2)}\n`);
  await writeFile(args.reportPath, `${buildReport(fixture, resultsByTask)}\n`);

  console.log(`[kg-oracle] wrote ${args.outPath}`);
  console.log(`[kg-oracle] wrote ${args.reportPath}`);
}

main().catch((err) => {
  console.error("[kg-oracle] failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
