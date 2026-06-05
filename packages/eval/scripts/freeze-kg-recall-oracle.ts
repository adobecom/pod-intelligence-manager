/**
 * Freeze a full live KG graph plus task query embeddings into the server-side
 * recall oracle fixture consumed by knowledge-graph-recall-golden.test.ts.
 *
 * Default behavior is review-safe: existing mustIncludeNodeIds are preserved,
 * new cases get an empty list, and a markdown candidate report is written for
 * human review. Pass --accept-current-results only when intentionally using the
 * current live high-budget query result as the initial baseline.
 *
 *   pnpm --filter @pim/eval freeze-kg-recall-oracle
 */
import "../src/load-env.js";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { pods as demoPods } from "@pim/shared";
import type {
  KnowledgeGraph,
  KnowledgeNode,
  KnowledgeQueryFilters,
  KnowledgeQueryResult,
} from "@pim/shared";
import {
  assertSecurePermissions,
  ensureFreshToken,
  loadCredentials,
} from "@pim/shared/auth";
import { ALL_TASKS } from "../src/tasks/index.js";
import { applyAssignmentsToAll } from "../src/tasks/stratification.js";
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
const DEFAULT_REPORT_PATH = join(__dirname, "..", "KG_RECALL_ORACLE_CANDIDATES.md");
const DEFAULT_API_BASE = "https://d1ygncl0yqo6sv.cloudfront.net";
const DEFAULT_ORG_SLUG = "emc-sandbox";
const DEFAULT_MAX_TOKENS = 1_000_000;
const DEFAULT_MIN_QUERY_SIMILARITY = 0.75;
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

interface ExistingOracleCase {
  taskId: string;
  mustIncludeNodeIds?: string[];
}

interface ExistingOracle {
  cases?: ExistingOracleCase[];
}

interface OracleCase {
  taskId: string;
  podId: string;
  description?: string;
  filters: KnowledgeQueryFilters;
  queryText: string;
  queryEmbedding: number[];
  mustIncludeNodeIds: string[];
}

interface RecallOracleFixture {
  formatVersion: 1;
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

interface CandidateRow {
  node: KnowledgeNode;
  returnedRank: number | null;
  required: boolean;
  cosine: number | null;
  keywordHits: number;
}

function usage(): string {
  return [
    "Usage: pnpm --filter @pim/eval freeze-kg-recall-oracle [options]",
    "",
    "Options:",
    "  --out=<path>                 Fixture path to write",
    "  --report=<path>              Markdown candidate report path to write",
    "  --api-base=<url>             PIM API base URL",
    "  --org=<slug>                 PIM org slug",
    "  --fixture-org-id=<id>        Org id stored inside the frozen fixture graph",
    "  --task=<id>                  Include only one task id; repeatable or comma-separated",
    "  --max-tokens=<n>             Query token budget for recall probing",
    "  --accept-current-results     Fill mustIncludeNodeIds with current live returned ids",
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
    if (arg === "--") {
      continue;
    } else if (arg === "--help" || arg === "-h") {
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
  const parts = [
    `Task: ${task.id}`,
    task.tags?.length ? `Tags: ${task.tags.join(", ")}` : "",
    task.expectedSignals?.length ? `Expected signals: ${task.expectedSignals.join(", ")}` : "",
    promptWithoutCode,
  ];
  return compactForKgQuery(parts.filter(Boolean).join("\n"));
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
    throw new Error("AWS_REGION and AWS_BEARER_TOKEN_BEDROCK are required to freeze query embeddings.");
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
  if (!res.ok) {
    throw new Error(`Bedrock embedding request failed: ${res.status} ${res.statusText} ${await res.text()}`);
  }
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

async function loadExistingRequiredIds(path: string): Promise<Map<string, string[]>> {
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw) as ExistingOracle;
    return new Map((parsed.cases ?? []).map((c) => [c.taskId, c.mustIncludeNodeIds ?? []]));
  } catch (err) {
    if (err instanceof Error && "code" in err && err.code === "ENOENT") return new Map();
    throw err;
  }
}

const STOP_WORDS = new Set([
  "the", "a", "an", "is", "was", "are", "were", "be", "been", "being",
  "have", "has", "had", "do", "does", "did", "will", "would", "could",
  "should", "may", "might", "shall", "can", "need", "to", "of", "in",
  "for", "on", "with", "at", "by", "from", "as", "into", "through",
  "during", "before", "after", "above", "below", "between", "and", "but",
  "or", "nor", "not", "so", "yet", "both", "either", "neither", "each",
  "every", "all", "any", "few", "more", "most", "other", "some", "such",
  "no", "only", "own", "same", "than", "too", "very", "just", "because",
  "this", "that", "these", "those", "it", "its", "they", "them", "their",
  "we", "us", "our", "you", "your", "he", "him", "his", "she", "her",
]);

function keywords(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, " ")
      .split(/\s+/)
      .filter((word) => word.length > 2 && !STOP_WORDS.has(word)),
  );
}

function keywordHits(queryText: string, node: KnowledgeNode): number {
  const queryKeywords = keywords(queryText);
  const nodeKeywords = keywords(`${node.summary} ${node.details}`);
  let hits = 0;
  for (const kw of queryKeywords) {
    if (nodeKeywords.has(kw)) hits++;
  }
  return hits;
}

function cosine(a: number[], b: number[] | undefined): number | null {
  if (!b || a.length !== b.length || a.length === 0) return null;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

function nodePassesFilters(node: KnowledgeNode, filters: KnowledgeQueryFilters): boolean {
  if (filters.domains?.length && !node.domains.some((domain) => filters.domains?.includes(domain))) return false;
  if (filters.types?.length && !filters.types.includes(node.type)) return false;
  if (filters.source_pod_ids?.length && !filters.source_pod_ids.includes(node.source_pod_id)) return false;
  if (filters.source_project_ids?.length) {
    if (!node.source_project_id || !filters.source_project_ids.includes(node.source_project_id)) return false;
  }
  if (filters.include_project_id) {
    if (node.source_project_id && node.source_project_id !== filters.include_project_id) return false;
  }
  if (node.confidence_score < (filters.confidence_min ?? 0.7)) return false;
  if (filters.curated_only && !node.curated) return false;
  if (!filters.include_superseded && node.superseded_by) return false;
  if (filters.text_search?.trim()) {
    const queryKeywords = keywords(filters.text_search);
    if (queryKeywords.size > 0) {
      const nodeKeywords = keywords(`${node.summary} ${node.details}`);
      let any = false;
      for (const kw of queryKeywords) {
        if (nodeKeywords.has(kw)) {
          any = true;
          break;
        }
      }
      if (!any) return false;
    }
  }
  return true;
}

function candidateRows(
  graph: KnowledgeGraph,
  testCase: OracleCase,
  returnedIds: string[],
): CandidateRow[] {
  const returnedRankById = new Map(returnedIds.map((id, index) => [id, index + 1]));
  const requiredIds = new Set(testCase.mustIncludeNodeIds);
  return graph.nodes
    .filter((node) => nodePassesFilters(node, testCase.filters))
    .map((node) => ({
      node,
      returnedRank: returnedRankById.get(node.id) ?? null,
      required: requiredIds.has(node.id),
      cosine: cosine(testCase.queryEmbedding, node.embedding),
      keywordHits: keywordHits(testCase.queryText, node),
    }))
    .sort((a, b) => {
      if (a.required !== b.required) return a.required ? -1 : 1;
      if (a.returnedRank !== null && b.returnedRank !== null) return a.returnedRank - b.returnedRank;
      if (a.returnedRank !== null) return -1;
      if (b.returnedRank !== null) return 1;
      return (b.cosine ?? -1) - (a.cosine ?? -1) || b.keywordHits - a.keywordHits || b.node.confidence_score - a.node.confidence_score;
    });
}

function mdCell(value: string, max = 140): string {
  const clean = value.replace(/\r?\n/g, " ").replace(/\s+/g, " ").replace(/\|/g, "\\|").trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}...` : clean;
}

function buildReport(
  fixture: RecallOracleFixture,
  resultsByTask: Map<string, QueryResponse>,
): string {
  const lines: string[] = [];
  lines.push("# KG Recall Oracle Candidate Review");
  lines.push("");
  lines.push(`Generated: ${fixture.generatedAt}`);
  lines.push(`Source org: \`${fixture.sourceOrgSlug}\``);
  lines.push(`Frozen graph: ${fixture.graph.nodes.length} nodes, ${fixture.graph.edges.length} edges`);
  lines.push("");
  lines.push("Review flow: add truly required node ids to `mustIncludeNodeIds` in the oracle fixture, then run the server golden test.");
  lines.push("");

  for (const testCase of fixture.cases) {
    const result = resultsByTask.get(testCase.taskId);
    const returnedIds = result?.nodes.map((node) => node.id) ?? [];
    const rows = candidateRows(fixture.graph, testCase, returnedIds);
    const reviewRows = rows
      .filter((row) => row.required || row.returnedRank !== null || (row.cosine ?? 0) >= DEFAULT_MIN_QUERY_SIMILARITY || row.keywordHits >= 2)
      .slice(0, 50);

    lines.push(`## ${testCase.taskId}`);
    lines.push("");
    lines.push(`- Pod: \`${testCase.podId}\``);
    lines.push(`- Reviewed required ids: ${testCase.mustIncludeNodeIds.map((id) => `\`${id}\``).join(", ") || "(none yet)"}`);
    lines.push(
      `- Live high-budget query returned ${returnedIds.length} node(s), total_matching=${result?.total_matching ?? "n/a"}, truncated=${result?.truncated ?? "n/a"}`,
    );
    lines.push("");
    lines.push("<details><summary>Task query</summary>");
    lines.push("");
    lines.push("```");
    lines.push(testCase.queryText);
    lines.push("```");
    lines.push("");
    lines.push("</details>");
    lines.push("");
    lines.push("| mark | live rank | node id | cosine | kw hits | conf | type | domains | summary |");
    lines.push("| --- | ---: | --- | ---: | ---: | ---: | --- | --- | --- |");
    for (const row of reviewRows) {
      const mark = row.required ? "required" : row.returnedRank !== null ? "returned" : "candidate";
      lines.push(
        `| ${mark} | ${row.returnedRank ?? ""} | \`${row.node.id}\` | ${row.cosine === null ? "n/a" : row.cosine.toFixed(4)} | ${row.keywordHits} | ${row.node.confidence_score.toFixed(2)} | ${row.node.type} | ${row.node.domains.join(", ")} | ${mdCell(row.node.summary)} |`,
      );
    }
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

  const selectedTasks = applyAssignmentsToAll(ALL_TASKS).filter((task) => {
    if (task.excluded) return false;
    return !args.taskIds || args.taskIds.has(task.id);
  });
  if (selectedTasks.length === 0) {
    throw new Error(`No tasks selected${args.taskIds ? ` for ${[...args.taskIds].join(", ")}` : ""}.`);
  }

  const headers = await authHeaders(args.orgSlug);
  const dimensions = embeddingDimensions();
  const existingRequiredIds = await loadExistingRequiredIds(args.outPath);

  console.log(`[kg-oracle] fetching full graph from ${args.apiBase} org=${args.orgSlug}`);
  const liveGraph = await fetchJson<KnowledgeGraph>(
    `${args.apiBase}/api/knowledge/graph?include_embeddings=true`,
    { method: "GET", headers },
  );
  const graph: KnowledgeGraph = { ...liveGraph, org_id: args.fixtureOrgId };

  const cases: OracleCase[] = [];
  const resultsByTask = new Map<string, QueryResponse>();
  for (const task of selectedTasks) {
    const queryText = buildTaskKgQuery(task);
    const queryEmbedding = await generateEmbedding(queryText, dimensions);
    const filters = taskFilters(task);
    const queryResult = await fetchJson<QueryResponse>(`${args.apiBase}/api/knowledge/query`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        filters,
        max_tokens: args.maxTokens,
        include_details: false,
        query_text: queryText,
        query_embedding: queryEmbedding,
      }),
    });
    resultsByTask.set(task.id, queryResult);

    const mustIncludeNodeIds = args.acceptCurrentResults
      ? queryResult.nodes.map((node) => node.id)
      : existingRequiredIds.get(task.id) ?? [];

    cases.push({
      taskId: task.id,
      podId: task.podId,
      description: taskDescription(task),
      filters,
      queryText,
      queryEmbedding,
      mustIncludeNodeIds,
    });

    console.log(
      `[kg-oracle] ${task.id}: live=${queryResult.nodes.length} matching=${queryResult.total_matching} required=${mustIncludeNodeIds.length}`,
    );
  }

  const fixture: RecallOracleFixture = {
    formatVersion: 1,
    orgId: args.fixtureOrgId,
    sourceOrgSlug: args.orgSlug,
    generatedAt: new Date().toISOString(),
    embedding: {
      provider: "bedrock",
      model: "amazon.titan-embed-text-v2:0",
      dimensions,
      normalized: true,
    },
    tuning: {
      minQuerySimilarity: DEFAULT_MIN_QUERY_SIMILARITY,
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

  const unreviewed = fixture.cases.filter((testCase) => testCase.mustIncludeNodeIds.length === 0);
  console.log(`[kg-oracle] wrote ${args.outPath}`);
  console.log(`[kg-oracle] wrote ${args.reportPath}`);
  if (unreviewed.length > 0) {
    console.warn(
      `[kg-oracle] ${unreviewed.length} case(s) have no mustIncludeNodeIds yet; review the report before relying on CI.`,
    );
  }
}

main().catch((err) => {
  console.error("[kg-oracle] failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
