#!/usr/bin/env node
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import {
  aggregateMetrics,
  evaluateRanking,
  percentile,
  type RankingMetrics,
} from "../eval/project-search/metrics.js";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const EVAL_DIR = path.resolve(SCRIPT_DIR, "../eval/project-search");
const DEFAULT_BASELINE_PATH = path.join(EVAL_DIR, "baseline.json");
const ORG_ID = "org-project-search-eval";
const USER_ID = "user-project-search-eval";
const PROJECT_ID = "project-search-eval";
const REVIEW_STATUS = "candidate_requires_human_review";
const STRATA = [
  "exact_identifier",
  "paraphrase",
  "current_status",
  "slack_thread",
  "confluence_doc",
] as const;

type Stratum = (typeof STRATA)[number];
type MetricKey = keyof RankingMetrics;

const METRIC_KEYS: MetricKey[] = [
  "recall_at_10",
  "ndcg_at_10",
  "mrr_at_10",
  "citation_correctness_at_10",
];

interface CorpusDocument {
  source: "jira" | "github" | "confluence" | "slack" | "git" | "project_update" | "pod_update" | "kg";
  source_type: string;
  source_id: string;
  source_url: string;
  title: string;
  author?: string;
  status?: string;
  occurred_at: string;
  body: string;
  comments?: string[];
  metadata?: Record<string, unknown>;
}

interface CorpusFixture {
  fixture_version: string;
  review_status: string;
  project: {
    name: string;
    resources: Record<string, unknown>;
  };
  documents: CorpusDocument[];
}

interface QueryCandidate {
  id: string;
  query: string;
  stratum: Stratum;
  intent: string;
  review_status: string;
}

interface QueryFixture {
  fixture_version: string;
  review_status: string;
  queries: QueryCandidate[];
}

interface Qrel {
  source_id: string;
  relevance: number;
  rationale: string;
  review_status: string;
}

interface QrelsFixture {
  fixture_version: string;
  review_status: string;
  qrels: Record<string, Qrel[]>;
}

interface RankedHit {
  rank: number;
  source_id: string;
  source: string;
  source_type: string;
  title: string;
  url?: string;
  score: number;
  matched: {
    identifier?: boolean;
    lexical?: boolean;
    semantic?: boolean;
    graph?: boolean;
    in_scope_resource?: boolean;
  };
}

interface QueryResult {
  id: string;
  query: string;
  stratum: Stratum;
  intent: string;
  review_status: string;
  latency_ms: number;
  metrics: RankingMetrics;
  top_10: RankedHit[];
}

interface EvaluationReport {
  schema_version: 1;
  fixture_version: string;
  review_status: string;
  generated_at: string;
  environment: {
    database: "temporary_sqlite";
    retrieval_mode: "lexical";
    fts_enabled: false;
    embeddings_enabled: false;
    synthesis_enabled: false;
    graph_expansion_enabled: false;
    kg_overlay_enabled: false;
    live_fallback_enabled: false;
    slack_ingestion_read_enabled: true;
    confluence_ingestion_read_enabled: true;
    confluence_source_instance: "eval.invalid";
    confluence_project_visible_space_keys: ["SRCH"];
    corpus_documents: number;
  };
  aggregate: ReturnType<typeof aggregateMetrics> & {
    latency_ms: { p50: number; p95: number };
  };
  by_stratum: Record<Stratum, ReturnType<typeof aggregateMetrics>>;
  queries: QueryResult[];
}

interface BaselineSnapshot {
  schema_version: 1;
  fixture_version: string;
  review_status: string;
  generated_at: string;
  environment: EvaluationReport["environment"];
  aggregate: EvaluationReport["aggregate"];
  by_stratum: EvaluationReport["by_stratum"];
  queries: Array<{
    id: string;
    metrics: RankingMetrics;
    top_10: Array<{ source_id: string; url?: string }>;
  }>;
}

interface QueryDiff {
  id: string;
  changed: boolean;
  metric_delta: Record<MetricKey, number>;
  current_latency_ms: number;
  added_to_top_10: string[];
  removed_from_top_10: string[];
  rank_changes: Array<{ source_id: string; baseline_rank: number | null; current_rank: number | null; delta: number | null }>;
}

interface ComparisonReport {
  baseline_path: string;
  compatible: boolean;
  aggregate_metric_delta: Record<MetricKey, number>;
  regression_count: number;
  regressions: string[];
  per_query_diffs: QueryDiff[];
}

interface CliOptions {
  comparePath?: string;
  freezePath?: string;
  outputPath?: string;
  failOnRegression: boolean;
  keepDb: boolean;
  help: boolean;
}

function usage(): string {
  return `Project Search deterministic evaluation

Usage:
  pnpm --filter @pim/server project-search-eval
  pnpm --filter @pim/server project-search-eval -- --freeze ${DEFAULT_BASELINE_PATH}
  pnpm --filter @pim/server project-search-eval -- --compare ${DEFAULT_BASELINE_PATH} [--fail-on-regression]

Options:
  --freeze <file>          Atomically write a compact ranked-output baseline.
  --compare <file>         Compare current rankings with a baseline.
  --output <file>          Atomically write the emitted report/envelope.
  --fail-on-regression     Exit 2 when any aggregate or per-query quality metric falls.
  --keep-db                Keep the temporary SQLite directory and print its path.
  --help                   Show this help.
`;
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = { failOnRegression: false, keepDb: false, help: false };
  const takePath = (flag: string, index: number): string => {
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${flag} requires a file path`);
    // pnpm changes cwd to the package directory but exposes the caller's cwd,
    // so documented repository-root paths should resolve as the caller wrote them.
    return path.resolve(process.env.INIT_CWD ?? process.cwd(), value);
  };

  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case "--":
        // pnpm preserves the conventional argument separator for package scripts.
        break;
      case "--freeze":
        options.freezePath = takePath("--freeze", i++);
        break;
      case "--compare":
        options.comparePath = takePath("--compare", i++);
        break;
      case "--output":
        options.outputPath = takePath("--output", i++);
        break;
      case "--fail-on-regression":
        options.failOnRegression = true;
        break;
      case "--keep-db":
        options.keepDb = true;
        break;
      case "--help":
      case "-h":
        options.help = true;
        break;
      default:
        throw new Error(`unknown option: ${argv[i]}`);
    }
  }
  if (options.freezePath && options.comparePath) throw new Error("--freeze and --compare are mutually exclusive");
  if (options.failOnRegression && !options.comparePath) throw new Error("--fail-on-regression requires --compare");
  return options;
}

async function loadJson<T>(fileName: string): Promise<T> {
  return JSON.parse(await readFile(path.join(EVAL_DIR, fileName), "utf8")) as T;
}

function assertString(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${label} must be a non-empty string`);
}

function validateFixtures(corpus: CorpusFixture, queries: QueryFixture, qrels: QrelsFixture): void {
  assertString(corpus.fixture_version, "corpus.fixture_version");
  if (queries.fixture_version !== corpus.fixture_version || qrels.fixture_version !== corpus.fixture_version) {
    throw new Error("corpus, queries, and qrels must use the same fixture_version");
  }
  for (const [name, status] of [
    ["corpus", corpus.review_status],
    ["queries", queries.review_status],
    ["qrels", qrels.review_status],
  ] as const) {
    if (status !== REVIEW_STATUS) throw new Error(`${name}.review_status must be ${REVIEW_STATUS}`);
  }
  assertString(corpus.project?.name, "corpus.project.name");
  if (!Array.isArray(corpus.documents) || corpus.documents.length < 20) {
    throw new Error("corpus.documents must contain at least 20 stable documents");
  }
  if (!Array.isArray(queries.queries) || queries.queries.length !== 25) {
    throw new Error(`queries.json must contain exactly 25 candidates; found ${queries.queries?.length ?? 0}`);
  }

  const sourceIds = new Set<string>();
  const urls = new Set<string>();
  for (const [index, document] of corpus.documents.entries()) {
    assertString(document.source_id, `documents[${index}].source_id`);
    assertString(document.source_url, `documents[${index}].source_url`);
    assertString(document.title, `documents[${index}].title`);
    assertString(document.body, `documents[${index}].body`);
    if (!document.source_url.startsWith("https://eval.invalid/")) {
      throw new Error(`fixture URL must be non-routable eval.invalid: ${document.source_url}`);
    }
    if (sourceIds.has(document.source_id)) throw new Error(`duplicate corpus source_id: ${document.source_id}`);
    if (urls.has(document.source_url)) throw new Error(`duplicate corpus source_url: ${document.source_url}`);
    if (Number.isNaN(Date.parse(document.occurred_at))) throw new Error(`invalid occurred_at for ${document.source_id}`);
    sourceIds.add(document.source_id);
    urls.add(document.source_url);
  }

  const queryIds = new Set<string>();
  const counts = new Map<Stratum, number>(STRATA.map((stratum) => [stratum, 0]));
  for (const query of queries.queries) {
    assertString(query.id, "query.id");
    assertString(query.query, `${query.id}.query`);
    assertString(query.intent, `${query.id}.intent`);
    if (!STRATA.includes(query.stratum)) throw new Error(`invalid stratum for ${query.id}: ${query.stratum}`);
    if (query.review_status !== REVIEW_STATUS) throw new Error(`${query.id} is missing candidate review status`);
    if (queryIds.has(query.id)) throw new Error(`duplicate query id: ${query.id}`);
    queryIds.add(query.id);
    counts.set(query.stratum, (counts.get(query.stratum) ?? 0) + 1);

    const judgments = qrels.qrels[query.id];
    if (!Array.isArray(judgments) || judgments.length === 0) throw new Error(`missing qrels for ${query.id}`);
    const judgedSources = new Set<string>();
    for (const judgment of judgments) {
      if (!sourceIds.has(judgment.source_id)) throw new Error(`${query.id} qrel references unknown ${judgment.source_id}`);
      if (!Number.isInteger(judgment.relevance) || judgment.relevance < 1 || judgment.relevance > 3) {
        throw new Error(`${query.id}/${judgment.source_id} relevance must be an integer from 1 to 3`);
      }
      assertString(judgment.rationale, `${query.id}/${judgment.source_id}.rationale`);
      if (judgment.review_status !== REVIEW_STATUS) {
        throw new Error(`${query.id}/${judgment.source_id} is missing candidate review status`);
      }
      if (judgedSources.has(judgment.source_id)) throw new Error(`${query.id} has duplicate qrel ${judgment.source_id}`);
      judgedSources.add(judgment.source_id);
    }
  }
  for (const stratum of STRATA) {
    if (counts.get(stratum) !== 5) throw new Error(`${stratum} must contain exactly 5 queries`);
  }
  const extraQrelIds = Object.keys(qrels.qrels).filter((id) => !queryIds.has(id));
  if (extraQrelIds.length > 0) throw new Error(`qrels contains unknown query ids: ${extraQrelIds.join(", ")}`);
}

function round(value: number, places = 6): number {
  const scale = 10 ** places;
  return Math.round((value + Number.EPSILON) * scale) / scale;
}

function roundedMetrics(metrics: RankingMetrics): RankingMetrics {
  return {
    recall_at_10: round(metrics.recall_at_10),
    ndcg_at_10: round(metrics.ndcg_at_10),
    mrr_at_10: round(metrics.mrr_at_10),
    citation_correctness_at_10: round(metrics.citation_correctness_at_10),
  };
}

async function atomicWriteJson(targetPath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(targetPath), { recursive: true });
  const temporaryPath = `${targetPath}.tmp-${process.pid}`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporaryPath, targetPath);
}

function metricDeltas(current: RankingMetrics, baseline: RankingMetrics): Record<MetricKey, number> {
  return Object.fromEntries(
    METRIC_KEYS.map((key) => [key, round(current[key] - baseline[key])]),
  ) as Record<MetricKey, number>;
}

function baselineFromReport(report: EvaluationReport): BaselineSnapshot {
  return {
    schema_version: 1,
    fixture_version: report.fixture_version,
    review_status: report.review_status,
    generated_at: report.generated_at,
    environment: report.environment,
    aggregate: report.aggregate,
    by_stratum: report.by_stratum,
    queries: report.queries.map((query) => ({
      id: query.id,
      metrics: query.metrics,
      top_10: query.top_10.map((hit) => ({
        source_id: hit.source_id,
        ...(hit.url ? { url: hit.url } : {}),
      })),
    })),
  };
}

function compareReports(current: EvaluationReport, baseline: BaselineSnapshot, baselinePath: string): ComparisonReport {
  if (baseline.schema_version !== 1 || baseline.fixture_version !== current.fixture_version) {
    throw new Error(
      `incompatible baseline: schema=${baseline.schema_version}, fixture=${baseline.fixture_version}; ` +
      `current schema=1, fixture=${current.fixture_version}`,
    );
  }
  const baselineById = new Map(baseline.queries.map((query) => [query.id, query]));
  const regressions: string[] = [];
  const aggregateMetricDelta = metricDeltas(current.aggregate, baseline.aggregate);
  for (const key of METRIC_KEYS) {
    if (aggregateMetricDelta[key] < 0) regressions.push(`aggregate ${key}: ${aggregateMetricDelta[key]}`);
  }

  const perQueryDiffs = current.queries.map((query): QueryDiff => {
    const previous = baselineById.get(query.id);
    if (!previous) throw new Error(`baseline is missing query ${query.id}`);
    const delta = metricDeltas(query.metrics, previous.metrics);
    for (const key of METRIC_KEYS) {
      if (delta[key] < 0) regressions.push(`${query.id} ${key}: ${delta[key]}`);
    }

    const oldRanks = new Map(previous.top_10.map((hit, index) => [hit.source_id, index + 1]));
    const newRanks = new Map(query.top_10.map((hit) => [hit.source_id, hit.rank]));
    const allSources = [...new Set([...oldRanks.keys(), ...newRanks.keys()])].sort();
    const rankChanges = allSources.flatMap((sourceId) => {
      const baselineRank = oldRanks.get(sourceId) ?? null;
      const currentRank = newRanks.get(sourceId) ?? null;
      if (baselineRank === currentRank) return [];
      return [{
        source_id: sourceId,
        baseline_rank: baselineRank,
        current_rank: currentRank,
        delta: baselineRank !== null && currentRank !== null ? currentRank - baselineRank : null,
      }];
    });
    const added = query.top_10.filter((hit) => !oldRanks.has(hit.source_id)).map((hit) => hit.source_id);
    const removed = previous.top_10.filter((hit) => !newRanks.has(hit.source_id)).map((hit) => hit.source_id);
    const metricsChanged = METRIC_KEYS.some((key) => delta[key] !== 0);
    return {
      id: query.id,
      changed: metricsChanged || rankChanges.length > 0,
      metric_delta: delta,
      current_latency_ms: query.latency_ms,
      added_to_top_10: added,
      removed_from_top_10: removed,
      rank_changes: rankChanges,
    };
  });

  const currentIds = new Set(current.queries.map((query) => query.id));
  const extraBaselineIds = baseline.queries.filter((query) => !currentIds.has(query.id)).map((query) => query.id);
  if (extraBaselineIds.length > 0) throw new Error(`baseline has extra query ids: ${extraBaselineIds.join(", ")}`);

  return {
    baseline_path: baselinePath,
    compatible: true,
    aggregate_metric_delta: aggregateMetricDelta,
    regression_count: regressions.length,
    regressions,
    per_query_diffs: perQueryDiffs,
  };
}

async function runEvaluation(
  corpus: CorpusFixture,
  queries: QueryFixture,
  qrels: QrelsFixture,
  keepDb: boolean,
): Promise<EvaluationReport> {
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "pim-project-search-eval-"));
  const databasePath = path.join(temporaryDirectory, "eval.sqlite");
  const gitFixtureRoot = path.join(temporaryDirectory, "git-fixture");
  await mkdir(gitFixtureRoot, { recursive: true });
  let closeDatabase: (() => void) | undefined;

  // connection.ts opens its singleton at import time, so the isolated path and
  // deterministic capability flags must be established before dynamic imports.
  process.env.DB_PATH = databasePath;
  delete process.env.AWS_BEARER_TOKEN_BEDROCK;
  delete process.env.AWS_REGION;
  process.env.PROJECT_SEARCH_LIVE_FALLBACK = "0";
  process.env.PROJECT_SLACK_INGESTION_ENABLED = "1";
  process.env.PROJECT_CONFLUENCE_INGESTION_ENABLED = "1";
  process.env.PROJECT_SLACK_SEARCH_ENABLED = "1";
  process.env.PROJECT_CONFLUENCE_SEARCH_ENABLED = "1";
  process.env.PROJECT_GITHUB_VISIBLE_REPOS = "acme/search";
  process.env.PROJECT_JIRA_VISIBLE_PROJECT_KEYS = "ACME";
  process.env.PROJECT_GIT_ALLOWED_ROOTS = gitFixtureRoot;
  process.env.CONFLUENCE_BASE_URL = "https://eval.invalid";
  // The fixture's SRCH space is the explicitly approved, project-wide-visible
  // Confluence boundary. Resource binding alone is not treated as permission.
  process.env.CONFLUENCE_PROJECT_VISIBLE_SPACE_KEYS = "SRCH";
  delete process.env.CONFLUENCE_PROJECT_VISIBLE_PAGE_IDS;

  try {
    const [{ createTables }, databaseModule, indexModule, searchModule] = await Promise.all([
      import("../src/db/schema.js"),
      import("../src/db/connection.js"),
      import("../src/services/project-search-index.js"),
      import("../src/services/project-search.js"),
    ]);
    const db = databaseModule.default;
    closeDatabase = () => db.close();
    createTables();

    // Force the production keyword-LIKE fallback so rankings are identical on
    // SQLite builds with and without the optional FTS5 module.
    db.exec("DROP TABLE IF EXISTS project_search_fts");

    const fixedTime = "2024-01-01T00:00:00.000Z";
    db.prepare(
      `INSERT INTO users (user_id, ims_user_id, email, display_name, is_service, created_at)
       VALUES (?, ?, ?, ?, 0, ?)`,
    ).run(USER_ID, "ims-project-search-eval", "project-search-eval@example.invalid", "Project Search Eval", fixedTime);
    db.prepare(
      `INSERT INTO orgs (org_id, slug, name, created_by_user_id, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(ORG_ID, "project-search-eval", "Project Search Eval", USER_ID, fixedTime);
    db.prepare(
      `INSERT INTO projects
         (project_id, name, description, created_at, resources_json, anatomy_json, org_id, created_by_user_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      PROJECT_ID,
      corpus.project.name,
      "Deterministic offline retrieval evaluation fixture",
      fixedTime,
      JSON.stringify({
        ...corpus.project.resources,
        git: { repo_paths: [gitFixtureRoot] },
      }),
      JSON.stringify({ internal: [], external: [] }),
      ORG_ID,
      USER_ID,
    );

    for (const document of corpus.documents) {
      indexModule.indexProjectDocument({
        org_id: ORG_ID,
        project_id: PROJECT_ID,
        source: document.source,
        source_type: document.source_type,
        source_id: document.source_id,
        source_url: document.source_url,
        title: document.title,
        ...(document.author ? { author: document.author } : {}),
        ...(document.status ? { status: document.status } : {}),
        occurred_at: document.occurred_at,
        body: document.body,
        ...(document.comments ? { comments: document.comments } : {}),
        metadata: document.metadata ?? {},
        permissions: { fixture: true },
        freshness_state: "fresh",
        source_instance: document.source === "confluence" ? "eval.invalid" : `fixture:${document.source}`,
        native_id: document.source_id,
        source_version: corpus.fixture_version,
        visibility: "project_visible",
        visibility_version: "fixture-v1",
        redaction_version: "fixture-v1",
        source_updated_at: document.occurred_at,
        graph_enabled: false,
      });
    }

    const requestFor = (query: string) => ({
      query,
      max_hits: 10,
      include_kg: false,
      include_mind_map: false,
      graph_expansion: false,
      synthesize: false,
      use_live: false,
    });

    // One unmeasured read removes schema/page-cache startup from the latency set.
    await searchModule.searchProject(ORG_ID, PROJECT_ID, requestFor(queries.queries[0].query));

    const expectedUrls = new Map(corpus.documents.map((document) => [document.source_id, document.source_url]));
    const queryResults: QueryResult[] = [];
    for (const candidate of queries.queries) {
      const start = performance.now();
      const response = await searchModule.searchProject(ORG_ID, PROJECT_ID, requestFor(candidate.query));
      const latencyMs = performance.now() - start;
      if (!response) throw new Error(`production search returned null for ${candidate.id}`);
      if (response.retrieval_mode !== "lexical") {
        throw new Error(`${candidate.id} unexpectedly used retrieval_mode=${response.retrieval_mode}`);
      }
      const top = response.hits.slice(0, 10).map((hit, index): RankedHit => ({
        rank: index + 1,
        source_id: hit.source_id,
        source: hit.source,
        source_type: hit.source_type,
        title: hit.title,
        ...(hit.url ? { url: hit.url } : {}),
        score: round(hit.score),
        matched: hit.matched,
      }));
      queryResults.push({
        id: candidate.id,
        query: candidate.query,
        stratum: candidate.stratum,
        intent: candidate.intent,
        review_status: candidate.review_status,
        latency_ms: round(latencyMs, 3),
        metrics: roundedMetrics(evaluateRanking(top, qrels.qrels[candidate.id], expectedUrls)),
        top_10: top,
      });
    }

    const aggregate = aggregateMetrics(queryResults.map((result) => result.metrics));
    const byStratum = Object.fromEntries(STRATA.map((stratum) => {
      const metrics = aggregateMetrics(
        queryResults.filter((result) => result.stratum === stratum).map((result) => result.metrics),
      );
      return [stratum, {
        query_count: metrics.query_count,
        recall_at_10: round(metrics.recall_at_10),
        ndcg_at_10: round(metrics.ndcg_at_10),
        mrr_at_10: round(metrics.mrr_at_10),
        citation_correctness_at_10: round(metrics.citation_correctness_at_10),
      }];
    })) as Record<Stratum, ReturnType<typeof aggregateMetrics>>;
    const latencies = queryResults.map((result) => result.latency_ms);

    return {
      schema_version: 1,
      fixture_version: corpus.fixture_version,
      review_status: REVIEW_STATUS,
      generated_at: new Date().toISOString(),
      environment: {
        database: "temporary_sqlite",
        retrieval_mode: "lexical",
        fts_enabled: false,
        embeddings_enabled: false,
        synthesis_enabled: false,
        graph_expansion_enabled: false,
        kg_overlay_enabled: false,
        live_fallback_enabled: false,
        slack_ingestion_read_enabled: true,
        confluence_ingestion_read_enabled: true,
        confluence_source_instance: "eval.invalid",
        confluence_project_visible_space_keys: ["SRCH"],
        corpus_documents: corpus.documents.length,
      },
      aggregate: {
        query_count: aggregate.query_count,
        recall_at_10: round(aggregate.recall_at_10),
        ndcg_at_10: round(aggregate.ndcg_at_10),
        mrr_at_10: round(aggregate.mrr_at_10),
        citation_correctness_at_10: round(aggregate.citation_correctness_at_10),
        latency_ms: {
          p50: round(percentile(latencies, 0.5), 3),
          p95: round(percentile(latencies, 0.95), 3),
        },
      },
      by_stratum: byStratum,
      queries: queryResults,
    };
  } finally {
    try {
      closeDatabase?.();
    } finally {
      if (keepDb) {
        console.error(`temporary evaluation database retained at ${databasePath}`);
      } else {
        await rm(temporaryDirectory, { recursive: true, force: true });
      }
    }
  }
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(usage());
    return;
  }

  const [corpus, queries, qrels] = await Promise.all([
    loadJson<CorpusFixture>("corpus.json"),
    loadJson<QueryFixture>("queries.json"),
    loadJson<QrelsFixture>("qrels.json"),
  ]);
  validateFixtures(corpus, queries, qrels);
  const baseline = options.comparePath
    ? JSON.parse(await readFile(options.comparePath, "utf8")) as BaselineSnapshot
    : undefined;
  const report = await runEvaluation(corpus, queries, qrels, options.keepDb);

  let comparison: ComparisonReport | undefined;
  if (options.comparePath && baseline) {
    comparison = compareReports(report, baseline, options.comparePath);
  }
  if (options.freezePath) await atomicWriteJson(options.freezePath, baselineFromReport(report));

  const output = comparison ? { report, comparison } : report;
  if (options.outputPath) await atomicWriteJson(options.outputPath, output);
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);

  if (comparison && options.failOnRegression && comparison.regression_count > 0) process.exitCode = 2;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 1;
});
