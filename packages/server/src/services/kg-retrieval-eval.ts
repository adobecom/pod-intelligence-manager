import type {
  KgContextContractMode,
  KnowledgeEdgeType,
  KnowledgeGraph,
  KnowledgeNode,
  KnowledgeQueryFilters,
  KnowledgeQueryResult,
} from "@pim/shared";
import { cosineSimilarity } from "./embeddings.js";
import { extractKeywords, extractRetrievalIdentifiers } from "./graph-analysis.js";
import {
  getRelevantLearningsForContractMode,
  loadGraphForOfflineEvaluation,
  queryKnowledge,
} from "./knowledge-graph.js";

export const RETRIEVAL_EVAL_BUDGETS = [1000, 4000, 8000, 1_000_000] as const;
export const DEFAULT_MAX_REQUIRED_RANK = 10;
export const STRICT_GATE_BUDGET = 4000;

export interface RetrievalOracleCase {
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

export interface RetrievalOracleFixture {
  formatVersion: 2;
  orgId: string;
  sourceOrgSlug: string;
  generatedAt: string;
  embedding: {
    provider: string;
    model: string;
    dimensions: number;
    normalized: boolean;
  };
  tuning: {
    minQuerySimilarity: number;
    recencyDecayDays: number;
    samePodDedupThreshold: number;
    crossPodDedupThreshold: number;
  };
  graph: KnowledgeGraph;
  cases: RetrievalOracleCase[];
}

export interface NodeRetrievalDiagnostics {
  nodeId: string;
  summary: string;
  type: KnowledgeNode["type"];
  domains: string[];
  rank: number | null;
  cosine: number | null;
  keywordHits: number;
  identifierHits: number;
  confidence: number;
  score?: number;
  scoreComponents?: NonNullable<KnowledgeQueryResult["explanations"]>[number]["score_components"];
  evidence?: NonNullable<KnowledgeQueryResult["explanations"]>[number]["evidence"];
  supersededBy?: string;
}

export interface BudgetMetrics {
  recallAt1: number | null;
  recallAt3: number | null;
  recallAt5: number | null;
  recallAt10: number | null;
  recallAtBudget: number | null;
  mrr: number | null;
  precisionAt3: number | null;
  precisionAt5: number | null;
  precisionAt10: number | null;
}

export interface BudgetEvaluation {
  budget: number;
  returnedCount: number;
  totalMatching: number;
  tokenEstimate: number;
  truncated: boolean;
  returnedIds: string[];
  requiredRanks: Record<string, number | null>;
  shouldRanks: Record<string, number | null>;
  forbiddenReturnedIds: string[];
  requiredWithinBudgetIds: string[];
  edgeTypeCounts: Partial<Record<KnowledgeEdgeType, number>>;
  metrics: BudgetMetrics;
  diagnostics: NodeRetrievalDiagnostics[];
}

export interface CaseEvaluation {
  taskId: string;
  podId: string;
  negativeControl: boolean;
  expectedMaxReturned?: number;
  maxRequiredRank: number;
  mustIncludeNodeIds: string[];
  shouldIncludeNodeIds: string[];
  mustNotIncludeNodeIds: string[];
  budgets: BudgetEvaluation[];
}

export interface RetrievalEvalFailure {
  taskId: string;
  budget: number;
  kind: "missing_required" | "bad_rank" | "negative_control_noise" | "forbidden_node" | "threshold";
  message: string;
}

export interface AggregateBudgetMetrics extends BudgetMetrics {
  casesWithRequired: number;
  meanReturnedCount: number;
  meanTokenEstimate: number;
  negativeControlViolations: number;
}

export interface RetrievalEvalReport {
  generatedAt: string;
  oracleGeneratedAt: string;
  orgId: string;
  budgets: number[];
  caseCount: number;
  failures: RetrievalEvalFailure[];
  aggregateByBudget: Record<string, AggregateBudgetMetrics>;
  cases: CaseEvaluation[];
}

export type ContractRetrievalMode = Extract<KgContextContractMode, "legacy" | "task_relevant">;

export interface ContractModeEvaluation {
  mode: ContractRetrievalMode;
  failures: RetrievalEvalFailure[];
  aggregateByBudget: Record<string, AggregateBudgetMetrics>;
  cases: CaseEvaluation[];
}

export interface ContractComparisonBudget {
  budget: number;
  winner: ContractRetrievalMode | "tie";
  recallAtBudgetDelta: number | null;
  mrrDelta: number | null;
  precisionAt5Delta: number | null;
  meanReturnedDelta: number;
  meanTokenEstimateDelta: number;
  legacyFailureCount: number;
  taskRelevantFailureCount: number;
}

export interface ContractComparisonReport {
  generatedAt: string;
  oracleGeneratedAt: string;
  orgId: string;
  budgets: number[];
  caseCount: number;
  modes: Record<ContractRetrievalMode, ContractModeEvaluation>;
  comparisonByBudget: Record<string, ContractComparisonBudget>;
}

function nodeText(node: KnowledgeNode): string {
  const refs = (node.entity_refs ?? []).map((ref) => `${ref.type} ${ref.label ?? ref.id}`).join(" ");
  return `${node.summary} ${node.details} ${node.retrieval_text ?? ""} ${refs}`;
}

function setIntersectionCount<T>(a: Set<T>, b: Set<T>): number {
  let hits = 0;
  for (const value of a) {
    if (b.has(value)) hits++;
  }
  return hits;
}

function rankMap(ids: string[]): Map<string, number> {
  return new Map(ids.map((id, index) => [id, index + 1]));
}

function ranksFor(ids: string[], ranks: Map<string, number>): Record<string, number | null> {
  return Object.fromEntries(ids.map((id) => [id, ranks.get(id) ?? null]));
}

function recallAt(ids: string[], ranks: Map<string, number>, k: number): number | null {
  if (ids.length === 0) return null;
  return ids.filter((id) => (ranks.get(id) ?? Number.POSITIVE_INFINITY) <= k).length / ids.length;
}

function recallAtBudget(ids: string[], ranks: Map<string, number>): number | null {
  if (ids.length === 0) return null;
  return ids.filter((id) => ranks.has(id)).length / ids.length;
}

function reciprocalRank(ids: string[], ranks: Map<string, number>): number | null {
  if (ids.length === 0) return null;
  const bestRank = Math.min(...ids.map((id) => ranks.get(id) ?? Number.POSITIVE_INFINITY));
  return Number.isFinite(bestRank) ? 1 / bestRank : 0;
}

function precisionAt(returnedIds: string[], relevantIds: Set<string>, k: number): number | null {
  if (relevantIds.size === 0) return null;
  const top = returnedIds.slice(0, k);
  if (top.length === 0) return 0;
  return top.filter((id) => relevantIds.has(id)).length / top.length;
}

function computeMetrics(
  returnedIds: string[],
  mustIncludeNodeIds: string[],
  shouldIncludeNodeIds: string[],
): BudgetMetrics {
  const ranks = rankMap(returnedIds);
  const relevantIds = new Set([...mustIncludeNodeIds, ...shouldIncludeNodeIds]);
  return {
    recallAt1: recallAt(mustIncludeNodeIds, ranks, 1),
    recallAt3: recallAt(mustIncludeNodeIds, ranks, 3),
    recallAt5: recallAt(mustIncludeNodeIds, ranks, 5),
    recallAt10: recallAt(mustIncludeNodeIds, ranks, 10),
    recallAtBudget: recallAtBudget(mustIncludeNodeIds, ranks),
    mrr: reciprocalRank(mustIncludeNodeIds, ranks),
    precisionAt3: precisionAt(returnedIds, relevantIds, 3),
    precisionAt5: precisionAt(returnedIds, relevantIds, 5),
    precisionAt10: precisionAt(returnedIds, relevantIds, 10),
  };
}

function edgeTypeCounts(graph: KnowledgeGraph, returnedIds: string[]): Partial<Record<KnowledgeEdgeType, number>> {
  const ids = new Set(returnedIds);
  const counts: Partial<Record<KnowledgeEdgeType, number>> = {};
  for (const edge of graph.edges) {
    if (!ids.has(edge.source) || !ids.has(edge.target)) continue;
    counts[edge.type] = (counts[edge.type] ?? 0) + 1;
  }
  return counts;
}

function diagnosticsForNodes(
  graph: KnowledgeGraph,
  testCase: RetrievalOracleCase,
  returnedIds: string[],
  result: KnowledgeQueryResult,
): NodeRetrievalDiagnostics[] {
  const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));
  const ranks = rankMap(returnedIds);
  const queryKeywords = extractKeywords(testCase.queryText);
  const queryIdentifiers = extractRetrievalIdentifiers(testCase.queryText);
  const explanationById = new Map((result.explanations ?? []).map((explanation) => [explanation.node_id, explanation]));
  const diagnosticIds = [
    ...testCase.mustIncludeNodeIds,
    ...(testCase.shouldIncludeNodeIds ?? []),
    ...(testCase.mustNotIncludeNodeIds ?? []),
    ...returnedIds.slice(0, 10),
  ];
  const seen = new Set<string>();
  const diagnostics: NodeRetrievalDiagnostics[] = [];

  for (const id of diagnosticIds) {
    if (seen.has(id)) continue;
    seen.add(id);
    const node = nodeById.get(id);
    if (!node) continue;
    const text = nodeText(node);
    const explanation = explanationById.get(id);
    diagnostics.push({
      nodeId: id,
      summary: node.summary,
      type: node.type,
      domains: node.domains,
      rank: ranks.get(id) ?? null,
      cosine: node.embedding && node.embedding.length === testCase.queryEmbedding.length
        ? cosineSimilarity(testCase.queryEmbedding, node.embedding)
        : null,
      keywordHits: setIntersectionCount(queryKeywords, extractKeywords(text)),
      identifierHits: setIntersectionCount(queryIdentifiers, extractRetrievalIdentifiers(text)),
      confidence: node.confidence_score,
      ...(explanation?.score !== undefined ? { score: explanation.score } : {}),
      ...(explanation?.score_components ? { scoreComponents: explanation.score_components } : {}),
      ...(explanation?.evidence ? { evidence: explanation.evidence } : {}),
      ...(node.superseded_by ? { supersededBy: node.superseded_by } : {}),
    });
  }

  return diagnostics;
}

function evaluateQueryResultAtBudget(
  oracle: RetrievalOracleFixture,
  testCase: RetrievalOracleCase,
  budget: number,
  result: KnowledgeQueryResult,
): BudgetEvaluation {
  const returnedIds = result.nodes.map((node) => node.id);
  const ranks = rankMap(returnedIds);
  const shouldIncludeNodeIds = testCase.shouldIncludeNodeIds ?? [];
  const mustNotIncludeNodeIds = testCase.mustNotIncludeNodeIds ?? [];
  const forbiddenReturnedIds = mustNotIncludeNodeIds.filter((id) => ranks.has(id));
  const requiredWithinBudgetIds = testCase.mustIncludeNodeIds.filter((id) => ranks.has(id));

  return {
    budget,
    returnedCount: returnedIds.length,
    totalMatching: result.total_matching,
    tokenEstimate: result.token_estimate,
    truncated: result.truncated,
    returnedIds,
    requiredRanks: ranksFor(testCase.mustIncludeNodeIds, ranks),
    shouldRanks: ranksFor(shouldIncludeNodeIds, ranks),
    forbiddenReturnedIds,
    requiredWithinBudgetIds,
    edgeTypeCounts: edgeTypeCounts(oracle.graph, returnedIds),
    metrics: computeMetrics(returnedIds, testCase.mustIncludeNodeIds, shouldIncludeNodeIds),
    diagnostics: diagnosticsForNodes(oracle.graph, testCase, returnedIds, result),
  };
}

function evaluateCaseAtBudget(
  oracle: RetrievalOracleFixture,
  testCase: RetrievalOracleCase,
  budget: number,
): BudgetEvaluation {
  loadGraphForOfflineEvaluation(oracle.graph, { allowUnsafeOrgId: true, allowReplacingLoadedOrg: true });
  const result = queryKnowledge(oracle.orgId, {
    filters: testCase.filters,
    max_tokens: budget,
    include_details: true,
    include_explanations: true,
    query_text: testCase.queryText,
    query_embedding: testCase.queryEmbedding,
  });
  return evaluateQueryResultAtBudget(oracle, testCase, budget, result);
}

function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function aggregateBudget(cases: CaseEvaluation[], budget: number): AggregateBudgetMetrics {
  const budgetRows = cases
    .map((testCase) => testCase.budgets.find((row) => row.budget === budget))
    .filter((row): row is BudgetEvaluation => !!row);
  const withRequired = budgetRows.filter((row) => row.metrics.recallAtBudget !== null);
  const metric = (selector: (row: BudgetEvaluation) => number | null): number | null =>
    mean(withRequired.map(selector).filter((value): value is number => value !== null));

  return {
    casesWithRequired: withRequired.length,
    meanReturnedCount: mean(budgetRows.map((row) => row.returnedCount)) ?? 0,
    meanTokenEstimate: mean(budgetRows.map((row) => row.tokenEstimate)) ?? 0,
    negativeControlViolations: cases.filter((testCase) => {
      if (!testCase.negativeControl || testCase.expectedMaxReturned === undefined) return false;
      const row = testCase.budgets.find((entry) => entry.budget === budget);
      return !!row && row.returnedCount > testCase.expectedMaxReturned;
    }).length,
    recallAt1: metric((row) => row.metrics.recallAt1),
    recallAt3: metric((row) => row.metrics.recallAt3),
    recallAt5: metric((row) => row.metrics.recallAt5),
    recallAt10: metric((row) => row.metrics.recallAt10),
    recallAtBudget: metric((row) => row.metrics.recallAtBudget),
    mrr: metric((row) => row.metrics.mrr),
    precisionAt3: mean(
      budgetRows
        .map((row) => row.metrics.precisionAt3)
        .filter((value): value is number => value !== null),
    ),
    precisionAt5: mean(
      budgetRows
        .map((row) => row.metrics.precisionAt5)
        .filter((value): value is number => value !== null),
    ),
    precisionAt10: mean(
      budgetRows
        .map((row) => row.metrics.precisionAt10)
        .filter((value): value is number => value !== null),
    ),
  };
}

function thresholdFailures(testCase: RetrievalOracleCase, row: BudgetEvaluation): RetrievalEvalFailure[] {
  const failures: RetrievalEvalFailure[] = [];
  const metrics = testCase.metrics;
  if (!metrics) return failures;
  const checks: Array<[keyof BudgetMetrics, number | undefined, string]> = [
    ["recallAtBudget", metrics.minRecallAtBudget, "Recall@budget"],
    ["mrr", metrics.minMrr, "MRR"],
    ["precisionAt3", metrics.minPrecisionAt3, "Precision@3"],
    ["precisionAt5", metrics.minPrecisionAt5, "Precision@5"],
    ["precisionAt10", metrics.minPrecisionAt10, "Precision@10"],
  ];
  for (const [metricName, threshold, label] of checks) {
    if (threshold === undefined) continue;
    const actual = row.metrics[metricName];
    if (actual === null || actual < threshold) {
      failures.push({
        taskId: testCase.taskId,
        budget: row.budget,
        kind: "threshold",
        message: `${label} ${actual ?? "n/a"} is below threshold ${threshold}`,
      });
    }
  }
  return failures;
}

function gateFailures(testCase: RetrievalOracleCase, row: BudgetEvaluation): RetrievalEvalFailure[] {
  const failures: RetrievalEvalFailure[] = [];
  const maxRank = testCase.maxRequiredRank ?? DEFAULT_MAX_REQUIRED_RANK;

  if (row.budget === STRICT_GATE_BUDGET) {
    const missing = testCase.mustIncludeNodeIds.filter((id) => row.requiredRanks[id] === null);
    if (missing.length > 0) {
      failures.push({
        taskId: testCase.taskId,
        budget: row.budget,
        kind: "missing_required",
        message: `missing required node(s): ${missing.join(", ")}`,
      });
    }

    const badRank = testCase.mustIncludeNodeIds.filter((id) => {
      const rank = row.requiredRanks[id];
      return rank !== null && rank > maxRank;
    });
    if (badRank.length > 0) {
      failures.push({
        taskId: testCase.taskId,
        budget: row.budget,
        kind: "bad_rank",
        message: `required node(s) ranked below ${maxRank}: ${badRank.map((id) => `${id}@${row.requiredRanks[id]}`).join(", ")}`,
      });
    }

    if (
      testCase.negativeControl &&
      testCase.expectedMaxReturned !== undefined &&
      row.returnedCount > testCase.expectedMaxReturned
    ) {
      failures.push({
        taskId: testCase.taskId,
        budget: row.budget,
        kind: "negative_control_noise",
        message: `negative control returned ${row.returnedCount} node(s), expected <= ${testCase.expectedMaxReturned}`,
      });
    }
  }

  if (row.forbiddenReturnedIds.length > 0) {
    failures.push({
      taskId: testCase.taskId,
      budget: row.budget,
      kind: "forbidden_node",
      message: `forbidden node(s) returned: ${row.forbiddenReturnedIds.join(", ")}`,
    });
  }

  failures.push(...thresholdFailures(testCase, row));
  return failures;
}

export function validateRetrievalOracle(oracle: RetrievalOracleFixture): string[] {
  const errors: string[] = [];
  if (oracle.formatVersion !== 2) errors.push(`formatVersion must be 2, got ${oracle.formatVersion}`);
  if (oracle.graph.org_id !== oracle.orgId) {
    errors.push(`graph.org_id ${oracle.graph.org_id} must match oracle.orgId ${oracle.orgId}`);
  }
  if (oracle.embedding.dimensions <= 0) errors.push("embedding.dimensions must be positive");
  if (oracle.cases.length === 0) errors.push("oracle must include at least one case");

  const nodeIds = new Set<string>();
  for (const node of oracle.graph.nodes) {
    if (nodeIds.has(node.id)) errors.push(`duplicate node id ${node.id}`);
    nodeIds.add(node.id);
    if (!node.embedding) {
      errors.push(`${node.id} is missing an embedding`);
    } else if (node.embedding.length !== oracle.embedding.dimensions) {
      errors.push(`${node.id} embedding dimension ${node.embedding.length} != ${oracle.embedding.dimensions}`);
    }
  }

  for (const testCase of oracle.cases) {
    if (testCase.queryEmbedding.length !== oracle.embedding.dimensions) {
      errors.push(`${testCase.taskId} query embedding dimension ${testCase.queryEmbedding.length} != ${oracle.embedding.dimensions}`);
    }
    if (testCase.mustIncludeNodeIds.length > 0 && testCase.reviewedNoRequiredNodes) {
      errors.push(`${testCase.taskId} cannot have mustIncludeNodeIds and reviewedNoRequiredNodes`);
    }
    if (testCase.reviewedNoRequiredNodes && (testCase.shouldIncludeNodeIds?.length ?? 0) > 0) {
      errors.push(`${testCase.taskId} cannot have shouldIncludeNodeIds and reviewedNoRequiredNodes`);
    }
    if (testCase.negativeControl && testCase.expectedMaxReturned === undefined) {
      errors.push(`${testCase.taskId} negativeControl must set expectedMaxReturned`);
    }
    if (testCase.expectedMaxReturned !== undefined && testCase.expectedMaxReturned < 0) {
      errors.push(`${testCase.taskId} expectedMaxReturned must be non-negative`);
    }

    const labels = [
      ...testCase.mustIncludeNodeIds.map((id) => ["mustIncludeNodeIds", id] as const),
      ...(testCase.shouldIncludeNodeIds ?? []).map((id) => ["shouldIncludeNodeIds", id] as const),
      ...(testCase.mustNotIncludeNodeIds ?? []).map((id) => ["mustNotIncludeNodeIds", id] as const),
    ];
    const seenLabels = new Set<string>();
    for (const [field, id] of labels) {
      if (!nodeIds.has(id)) errors.push(`${testCase.taskId}.${field} references unknown node ${id}`);
      const key = `${field}:${id}`;
      if (seenLabels.has(key)) errors.push(`${testCase.taskId}.${field} duplicates node ${id}`);
      seenLabels.add(key);
    }
    const must = new Set(testCase.mustIncludeNodeIds);
    const mustNot = new Set(testCase.mustNotIncludeNodeIds ?? []);
    for (const id of must) {
      if (mustNot.has(id)) errors.push(`${testCase.taskId} marks ${id} as both required and forbidden`);
    }
  }

  return errors;
}

export function evaluateRetrievalOracle(
  oracle: RetrievalOracleFixture,
  budgets: readonly number[] = RETRIEVAL_EVAL_BUDGETS,
): RetrievalEvalReport {
  const cases = oracle.cases.map((testCase): CaseEvaluation => {
    const caseBudgets = budgets.map((budget) => evaluateCaseAtBudget(oracle, testCase, budget));
    return {
      taskId: testCase.taskId,
      podId: testCase.podId,
      negativeControl: testCase.negativeControl ?? false,
      ...(testCase.expectedMaxReturned !== undefined ? { expectedMaxReturned: testCase.expectedMaxReturned } : {}),
      maxRequiredRank: testCase.maxRequiredRank ?? DEFAULT_MAX_REQUIRED_RANK,
      mustIncludeNodeIds: testCase.mustIncludeNodeIds,
      shouldIncludeNodeIds: testCase.shouldIncludeNodeIds ?? [],
      mustNotIncludeNodeIds: testCase.mustNotIncludeNodeIds ?? [],
      budgets: caseBudgets,
    };
  });

  const failures = cases.flatMap((caseEval) => {
    const sourceCase = oracle.cases.find((testCase) => testCase.taskId === caseEval.taskId)!;
    return caseEval.budgets.flatMap((row) => gateFailures(sourceCase, row));
  });

  return {
    generatedAt: new Date().toISOString(),
    oracleGeneratedAt: oracle.generatedAt,
    orgId: oracle.orgId,
    budgets: [...budgets],
    caseCount: oracle.cases.length,
    failures,
    aggregateByBudget: Object.fromEntries(budgets.map((budget) => [String(budget), aggregateBudget(cases, budget)])),
    cases,
  };
}

function scopesForContractCase(testCase: RetrievalOracleCase): string[] {
  return testCase.filters.scopes?.length
    ? testCase.filters.scopes
    : testCase.filters.domains ?? [];
}

async function evaluateContractModeCaseAtBudget(
  oracle: RetrievalOracleFixture,
  testCase: RetrievalOracleCase,
  mode: ContractRetrievalMode,
  budget: number,
): Promise<BudgetEvaluation> {
  loadGraphForOfflineEvaluation(oracle.graph, { allowUnsafeOrgId: true, allowReplacingLoadedOrg: true });
  const result = await getRelevantLearningsForContractMode(oracle.orgId, mode, {
    scopes: scopesForContractCase(testCase),
    projectId: testCase.filters.include_project_id,
    taskQuery: testCase.queryText,
    taskQueryEmbedding: testCase.queryEmbedding,
    maxTokens: budget,
  });
  return evaluateQueryResultAtBudget(oracle, testCase, budget, result);
}

async function evaluateContractModeCase(
  oracle: RetrievalOracleFixture,
  testCase: RetrievalOracleCase,
  mode: ContractRetrievalMode,
  budgets: readonly number[],
): Promise<CaseEvaluation> {
  const caseBudgets: BudgetEvaluation[] = [];
  for (const budget of budgets) {
    caseBudgets.push(await evaluateContractModeCaseAtBudget(oracle, testCase, mode, budget));
  }
  return {
    taskId: testCase.taskId,
    podId: testCase.podId,
    negativeControl: testCase.negativeControl ?? false,
    ...(testCase.expectedMaxReturned !== undefined ? { expectedMaxReturned: testCase.expectedMaxReturned } : {}),
    maxRequiredRank: testCase.maxRequiredRank ?? DEFAULT_MAX_REQUIRED_RANK,
    mustIncludeNodeIds: testCase.mustIncludeNodeIds,
    shouldIncludeNodeIds: testCase.shouldIncludeNodeIds ?? [],
    mustNotIncludeNodeIds: testCase.mustNotIncludeNodeIds ?? [],
    budgets: caseBudgets,
  };
}

async function evaluateContractMode(
  oracle: RetrievalOracleFixture,
  mode: ContractRetrievalMode,
  budgets: readonly number[],
): Promise<ContractModeEvaluation> {
  const cases: CaseEvaluation[] = [];
  for (const testCase of oracle.cases) {
    cases.push(await evaluateContractModeCase(oracle, testCase, mode, budgets));
  }
  const failures = cases.flatMap((caseEval) => {
    const sourceCase = oracle.cases.find((testCase) => testCase.taskId === caseEval.taskId)!;
    return caseEval.budgets.flatMap((row) => gateFailures(sourceCase, row));
  });

  return {
    mode,
    failures,
    aggregateByBudget: Object.fromEntries(budgets.map((budget) => [String(budget), aggregateBudget(cases, budget)])),
    cases,
  };
}

function nullableDelta(a: number | null, b: number | null): number | null {
  if (a === null || b === null) return null;
  return a - b;
}

function failureCountForBudget(evaluation: ContractModeEvaluation, budget: number): number {
  return evaluation.failures.filter((failure) => failure.budget === budget).length;
}

function chooseContractWinner(
  legacy: AggregateBudgetMetrics,
  taskRelevant: AggregateBudgetMetrics,
): ContractRetrievalMode | "tie" {
  const comparisons: Array<[number | null, ContractRetrievalMode]> = [
    [nullableDelta(taskRelevant.recallAtBudget, legacy.recallAtBudget), "task_relevant"],
    [nullableDelta(taskRelevant.mrr, legacy.mrr), "task_relevant"],
    [nullableDelta(taskRelevant.precisionAt5, legacy.precisionAt5), "task_relevant"],
  ];
  const epsilon = 0.0005;
  for (const [delta, positiveWinner] of comparisons) {
    if (delta === null || Math.abs(delta) <= epsilon) continue;
    return delta > 0 ? positiveWinner : "legacy";
  }

  const tokenDelta = taskRelevant.meanTokenEstimate - legacy.meanTokenEstimate;
  if (Math.abs(tokenDelta) > 1) return tokenDelta < 0 ? "task_relevant" : "legacy";
  return "tie";
}

export async function evaluateContractRetrievalOracle(
  oracle: RetrievalOracleFixture,
  budgets: readonly number[] = RETRIEVAL_EVAL_BUDGETS,
): Promise<ContractComparisonReport> {
  const legacy = await evaluateContractMode(oracle, "legacy", budgets);
  const taskRelevant = await evaluateContractMode(oracle, "task_relevant", budgets);
  const modes: Record<ContractRetrievalMode, ContractModeEvaluation> = {
    legacy,
    task_relevant: taskRelevant,
  };

  return {
    generatedAt: new Date().toISOString(),
    oracleGeneratedAt: oracle.generatedAt,
    orgId: oracle.orgId,
    budgets: [...budgets],
    caseCount: oracle.cases.length,
    modes,
    comparisonByBudget: Object.fromEntries(budgets.map((budget) => {
      const legacyAgg = legacy.aggregateByBudget[String(budget)];
      const taskAgg = taskRelevant.aggregateByBudget[String(budget)];
      const comparison: ContractComparisonBudget = {
        budget,
        winner: chooseContractWinner(legacyAgg, taskAgg),
        recallAtBudgetDelta: nullableDelta(taskAgg.recallAtBudget, legacyAgg.recallAtBudget),
        mrrDelta: nullableDelta(taskAgg.mrr, legacyAgg.mrr),
        precisionAt5Delta: nullableDelta(taskAgg.precisionAt5, legacyAgg.precisionAt5),
        meanReturnedDelta: taskAgg.meanReturnedCount - legacyAgg.meanReturnedCount,
        meanTokenEstimateDelta: taskAgg.meanTokenEstimate - legacyAgg.meanTokenEstimate,
        legacyFailureCount: failureCountForBudget(legacy, budget),
        taskRelevantFailureCount: failureCountForBudget(taskRelevant, budget),
      };
      return [String(budget), comparison];
    })),
  };
}

function fmt(value: number | null | undefined): string {
  if (value === null || value === undefined) return "n/a";
  return value.toFixed(3);
}

function fmtSigned(value: number | null | undefined): string {
  if (value === null || value === undefined) return "n/a";
  if (Math.abs(value) < 0.0005) return "0.000";
  return `${value > 0 ? "+" : ""}${value.toFixed(3)}`;
}

function mdCell(value: string): string {
  return value.replace(/\r?\n/g, " ").replace(/\|/g, "\\|").trim();
}

export function renderRetrievalEvalMarkdown(report: RetrievalEvalReport): string {
  const lines: string[] = [];
  lines.push("# KG Retrieval Eval");
  lines.push("");
  lines.push(`Generated: ${report.generatedAt}`);
  lines.push(`Oracle generated: ${report.oracleGeneratedAt}`);
  lines.push(`Org: \`${report.orgId}\``);
  lines.push(`Cases: ${report.caseCount}`);
  lines.push(`Failures: ${report.failures.length}`);
  lines.push("");
  lines.push("Metrics below evaluate the ranked candidate list returned by retrieval. Recall@3 is the proxy for the default three-node compact context; prompt serialization and character clipping are tested separately.");
  lines.push("");
  lines.push("## Aggregate Metrics");
  lines.push("");
  lines.push("| budget | Recall@1 | Recall@3 | Recall@5 | Recall@10 | Recall@budget | MRR | Precision@3 | Precision@5 | Precision@10 | mean returned | mean tokens |");
  lines.push("| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |");
  for (const budget of report.budgets) {
    const agg = report.aggregateByBudget[String(budget)];
    lines.push(
      `| ${budget} | ${fmt(agg.recallAt1)} | ${fmt(agg.recallAt3)} | ${fmt(agg.recallAt5)} | ${fmt(agg.recallAt10)} | ${fmt(agg.recallAtBudget)} | ${fmt(agg.mrr)} | ${fmt(agg.precisionAt3)} | ${fmt(agg.precisionAt5)} | ${fmt(agg.precisionAt10)} | ${agg.meanReturnedCount.toFixed(1)} | ${agg.meanTokenEstimate.toFixed(1)} |`,
    );
  }
  lines.push("");

  if (report.failures.length > 0) {
    lines.push("## Failures");
    lines.push("");
    for (const failure of report.failures) {
      lines.push(`- ${failure.kind} ${failure.taskId} @ ${failure.budget}: ${failure.message}`);
    }
    lines.push("");
  }

  lines.push("## Case Metrics At 4000 Tokens");
  lines.push("");
  lines.push("| task | returned | token estimate | Recall@5 | Recall@budget | MRR | Precision@5 | required ranks | edge types |");
  lines.push("| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- |");
  for (const testCase of report.cases) {
    const row = testCase.budgets.find((entry) => entry.budget === STRICT_GATE_BUDGET) ?? testCase.budgets[0];
    const ranks = Object.entries(row.requiredRanks).map(([id, rank]) => `${id}:${rank ?? "miss"}`).join(", ");
    const edgeTypes = Object.entries(row.edgeTypeCounts).map(([type, count]) => `${type}:${count}`).join(", ");
    lines.push(
      `| ${mdCell(testCase.taskId)} | ${row.returnedCount} | ${row.tokenEstimate} | ${fmt(row.metrics.recallAt5)} | ${fmt(row.metrics.recallAtBudget)} | ${fmt(row.metrics.mrr)} | ${fmt(row.metrics.precisionAt5)} | ${mdCell(ranks || "n/a")} | ${mdCell(edgeTypes || "n/a")} |`,
    );
  }
  lines.push("");
  return `${lines.join("\n")}\n`;
}

export function renderContractComparisonMarkdown(report: ContractComparisonReport): string {
  const lines: string[] = [];
  lines.push("# KG Context Contract Comparison");
  lines.push("");
  lines.push(`Generated: ${report.generatedAt}`);
  lines.push(`Oracle generated: ${report.oracleGeneratedAt}`);
  lines.push(`Org: \`${report.orgId}\``);
  lines.push(`Cases: ${report.caseCount}`);
  lines.push("");
  lines.push("Quality metrics cover the ranked candidate list returned by each contract. Recall@3 is the default compact-context proxy; this comparison does not claim that every lower-ranked candidate is delivered in the compact prompt.");
  lines.push("");
  lines.push("Deltas are `task_relevant - legacy`; positive quality deltas favor `task_relevant`, negative token/returned deltas mean it is more compact.");
  lines.push("");
  lines.push("## Budget Comparison");
  lines.push("");
  lines.push("| budget | winner | legacy Recall@budget | task Recall@budget | Recall delta | legacy MRR | task MRR | MRR delta | legacy P@5 | task P@5 | P@5 delta | legacy mean returned | task mean returned | returned delta | legacy mean tokens | task mean tokens | token delta | failures legacy/task |");
  lines.push("| ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |");
  for (const budget of report.budgets) {
    const legacy = report.modes.legacy.aggregateByBudget[String(budget)];
    const task = report.modes.task_relevant.aggregateByBudget[String(budget)];
    const comparison = report.comparisonByBudget[String(budget)];
    lines.push(
      `| ${budget} | ${comparison.winner} | ${fmt(legacy.recallAtBudget)} | ${fmt(task.recallAtBudget)} | ${fmtSigned(comparison.recallAtBudgetDelta)} | ${fmt(legacy.mrr)} | ${fmt(task.mrr)} | ${fmtSigned(comparison.mrrDelta)} | ${fmt(legacy.precisionAt5)} | ${fmt(task.precisionAt5)} | ${fmtSigned(comparison.precisionAt5Delta)} | ${legacy.meanReturnedCount.toFixed(1)} | ${task.meanReturnedCount.toFixed(1)} | ${comparison.meanReturnedDelta.toFixed(1)} | ${legacy.meanTokenEstimate.toFixed(1)} | ${task.meanTokenEstimate.toFixed(1)} | ${comparison.meanTokenEstimateDelta.toFixed(1)} | ${comparison.legacyFailureCount}/${comparison.taskRelevantFailureCount} |`,
    );
  }
  lines.push("");

  lines.push("## Strict Budget Case Metrics");
  lines.push("");
  lines.push("| task | legacy returned | task returned | legacy tokens | task tokens | legacy Recall@budget | task Recall@budget | legacy MRR | task MRR | required ranks legacy | required ranks task |");
  lines.push("| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- |");
  const legacyCases = new Map(report.modes.legacy.cases.map((testCase) => [testCase.taskId, testCase]));
  for (const taskCase of report.modes.task_relevant.cases) {
    const legacyCase = legacyCases.get(taskCase.taskId);
    if (!legacyCase) continue;
    const legacyRow = legacyCase.budgets.find((entry) => entry.budget === STRICT_GATE_BUDGET) ?? legacyCase.budgets[0];
    const taskRow = taskCase.budgets.find((entry) => entry.budget === STRICT_GATE_BUDGET) ?? taskCase.budgets[0];
    const legacyRanks = Object.entries(legacyRow.requiredRanks).map(([id, rank]) => `${id}:${rank ?? "miss"}`).join(", ");
    const taskRanks = Object.entries(taskRow.requiredRanks).map(([id, rank]) => `${id}:${rank ?? "miss"}`).join(", ");
    lines.push(
      `| ${mdCell(taskCase.taskId)} | ${legacyRow.returnedCount} | ${taskRow.returnedCount} | ${legacyRow.tokenEstimate} | ${taskRow.tokenEstimate} | ${fmt(legacyRow.metrics.recallAtBudget)} | ${fmt(taskRow.metrics.recallAtBudget)} | ${fmt(legacyRow.metrics.mrr)} | ${fmt(taskRow.metrics.mrr)} | ${mdCell(legacyRanks || "n/a")} | ${mdCell(taskRanks || "n/a")} |`,
    );
  }
  lines.push("");
  return `${lines.join("\n")}\n`;
}

export function formatRetrievalEvalFailures(report: RetrievalEvalReport): string {
  if (report.failures.length === 0) return "";
  const byTask = new Map<string, RetrievalEvalFailure[]>();
  for (const failure of report.failures) {
    const failures = byTask.get(failure.taskId) ?? [];
    failures.push(failure);
    byTask.set(failure.taskId, failures);
  }
  const lines: string[] = ["KG retrieval eval failed:"];
  for (const [taskId, failures] of byTask) {
    lines.push(`- ${taskId}`);
    for (const failure of failures) {
      lines.push(`  - ${failure.kind} @ ${failure.budget}: ${failure.message}`);
    }
  }
  return lines.join("\n");
}
