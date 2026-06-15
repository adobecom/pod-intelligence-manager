import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { LicContextFixture, LicIndexSource } from "../arms/types.js";
import type { Task } from "../tasks/types.js";
import {
  deriveLicFixtureQuality,
  extractGroundTruthChunks,
  extractGroundTruthFiles,
  extractGroundTruthSymbols,
  extractTaskContractEvidence,
  hasNoDefinitionSignal,
  hasPositiveSearchResults,
  isLikelyAnswerSymbol,
  type LicFixtureQuality,
  type LicFixtureSignal,
} from "./lic-quality.js";

export type LicRetrievalQueryMode = "fixture" | "task-prompt" | "lic-seed" | "oracle-symbols";
export type LicRetrievalSurface = "rawOutput" | "renderedBlock";

export interface LicRetrievalCall {
  tool?: string;
  args?: string[];
  cwd?: string;
  exitCode?: number | null;
  durationMs?: number;
  output?: string;
}

export interface LicRetrievalFixture extends LicContextFixture {
  licDaemonVersion?: string;
  indexSource?: LicIndexSource;
  calls?: LicRetrievalCall[];
}

export interface LicRetrievalOracleCase {
  taskId: string;
  queryText: string;
  queryMode: LicRetrievalQueryMode;
  indexSource: LicIndexSource;
  requiredFiles: string[];
  requiredSymbols: string[];
  shouldIncludeFiles?: string[];
  shouldIncludeSymbols?: string[];
  contractEvidence?: string[];
  forbiddenTextFragments?: string[];
  forbiddenSymbols?: string[];
}

export interface LicRetrievalItemRecall {
  required: string[];
  hits: string[];
  missing: string[];
  recall: number | null;
}

export interface LicRetrievalSurfaceEvaluation {
  surface: LicRetrievalSurface;
  charCount: number;
  files: LicRetrievalItemRecall;
  symbols: LicRetrievalItemRecall;
  contractEvidence: LicRetrievalItemRecall;
}

export type LicRetrievalBlockingKind = "missing_fixture" | "index_source" | "answer_leak";

export interface LicRetrievalBlockingFinding {
  taskId: string;
  kind: LicRetrievalBlockingKind;
  message: string;
  symbols?: string[];
  textFragments?: string[];
}

export interface LicRetrievalCaseEvaluation {
  taskId: string;
  stratum?: Task["stratum"];
  fixturePath?: string;
  fixtureMissing: boolean;
  claimEligible: boolean;
  expectedIndexSource: LicIndexSource;
  actualIndexSource?: LicIndexSource;
  indexSourceMatchesOracle: boolean;
  oracle: LicRetrievalOracleCase;
  quality?: LicFixtureQuality;
  noResult: boolean;
  weakResult: boolean;
  rawOutputChars: number;
  renderedBlockChars: number;
  rawOutput: LicRetrievalSurfaceEvaluation;
  renderedBlock: LicRetrievalSurfaceEvaluation;
  leakage: {
    answerLeak: boolean;
    forbiddenTextFragments: string[];
    forbiddenSymbols: string[];
  };
  blockingFindings: LicRetrievalBlockingFinding[];
}

export interface LicRetrievalAggregateSurface {
  fileRecall: number | null;
  symbolRecall: number | null;
  contractEvidenceRecall: number | null;
  fileHits: number;
  fileRequired: number;
  symbolHits: number;
  symbolRequired: number;
  contractEvidenceHits: number;
  contractEvidenceRequired: number;
  casesWithFiles: number;
  casesWithSymbols: number;
  casesWithContractEvidence: number;
}

export interface LicRetrievalEvalReport {
  generatedAt: string;
  taskSet: string;
  taskIds: string[];
  caseCount: number;
  fixtureCount: number;
  rawOutput: LicRetrievalAggregateSurface;
  renderedBlock: LicRetrievalAggregateSurface;
  leakageInvariantFailures: number;
  claimBlockingFindings: LicRetrievalBlockingFinding[];
  missingFixtures: number;
  indexSourceFailures: number;
  noResultRate: number;
  weakResultRate: number;
  meanRawOutputChars: number;
  meanRenderedBlockChars: number;
  fixtureQualityDistribution: Record<LicFixtureSignal | "missing", number>;
  cases: LicRetrievalCaseEvaluation[];
}

interface AggregateCounters {
  fileHits: number;
  fileRequired: number;
  symbolHits: number;
  symbolRequired: number;
  contractEvidenceHits: number;
  contractEvidenceRequired: number;
  casesWithFiles: number;
  casesWithSymbols: number;
  casesWithContractEvidence: number;
}

export function buildLicRetrievalOracleCase(
  task: Task,
  fixture?: LicRetrievalFixture,
  queryMode: LicRetrievalQueryMode = "fixture",
): LicRetrievalOracleCase {
  const requiredFiles = extractGroundTruthFiles(task.groundTruth?.output ?? "");
  const groundTruthSymbols = extractGroundTruthSymbols(task, "").symbols;
  const kgRequiredSymbols = task.kgExpectations?.requiredSymbols ?? [];
  const futureOrSynthetic = isFutureOrSyntheticTask(task);
  const requiredSymbols =
    futureOrSynthetic && kgRequiredSymbols.length > 0
      ? kgRequiredSymbols
      : groundTruthSymbols;

  const shouldIncludeSymbols =
    futureOrSynthetic
      ? dedupe([...(task.licSignals ?? []), ...(task.expectedSignals ?? [])])
      : kgRequiredSymbols;

  const forbiddenSymbols = groundTruthSymbols.filter(isLikelyAnswerSymbol);

  return {
    taskId: task.id,
    queryText: queryTextForMode(task, fixture, queryMode),
    queryMode,
    indexSource: expectedIndexSource(task, fixture),
    requiredFiles: dedupe(requiredFiles),
    requiredSymbols: dedupe(requiredSymbols),
    shouldIncludeFiles: [],
    shouldIncludeSymbols: dedupe(shouldIncludeSymbols),
    contractEvidence: dedupe(extractTaskContractEvidence(task)),
    forbiddenTextFragments: extractGroundTruthChunks(task.groundTruth?.output ?? ""),
    forbiddenSymbols: dedupe(forbiddenSymbols),
  };
}

export function evaluateLicRetrievalFixtures(
  tasks: Task[],
  fixtures: Map<string, LicRetrievalFixture>,
  options: { taskSet: string; generatedAt?: string } = { taskSet: "custom" },
): LicRetrievalEvalReport {
  const cases = tasks.map((task) => scoreLicRetrievalCase(task, fixtures.get(task.id)));
  return aggregateLicRetrievalCases(cases, {
    taskSet: options.taskSet,
    generatedAt: options.generatedAt ?? new Date().toISOString(),
  });
}

export function scoreLicRetrievalCase(task: Task, fixture?: LicRetrievalFixture): LicRetrievalCaseEvaluation {
  const oracle = buildLicRetrievalOracleCase(task, fixture);
  const rawText = fixture ? rawOutputText(fixture) : "";
  const renderedText = fixture?.renderedBlock ?? "";
  const combinedText = [rawText, renderedText].filter(Boolean).join("\n");
  const quality = fixture ? deriveLicFixtureQuality(task, fixture) : undefined;
  const actualIndexSource = fixture?.indexSource;
  const indexSourceMatchesOracle = fixture ? matchesIndexSource(oracle.indexSource, actualIndexSource) : false;
  const forbiddenTextFragments = hitsForItems(oracle.forbiddenTextFragments ?? [], combinedText);
  const leakedSymbols = dedupe([
    ...hitsForItems(oracle.forbiddenSymbols ?? [], renderedText),
    ...extractGroundTruthSymbols(task, renderedText).leakedSymbols,
  ]);
  const answerLeak = forbiddenTextFragments.length > 0 || leakedSymbols.length > 0;

  const blockingFindings: LicRetrievalBlockingFinding[] = [];
  const claimEligible = isClaimEligibleTask(task);
  if (!fixture && claimEligible) {
    blockingFindings.push({
      taskId: task.id,
      kind: "missing_fixture",
      message: `claim-eligible task ${task.id} has no LIC fixture`,
    });
  }
  if (fixture && !indexSourceMatchesOracle && claimEligible) {
    blockingFindings.push({
      taskId: task.id,
      kind: "index_source",
      message: `fixture index source ${formatIndexSource(actualIndexSource)} does not match oracle ${formatIndexSource(oracle.indexSource)}`,
    });
  }
  if (answerLeak && claimEligible) {
    blockingFindings.push({
      taskId: task.id,
      kind: "answer_leak",
      message: `fixture contains post-merge answer evidence for ${task.id}`,
      ...(leakedSymbols.length > 0 ? { symbols: leakedSymbols } : {}),
      ...(forbiddenTextFragments.length > 0 ? { textFragments: forbiddenTextFragments } : {}),
    });
  }

  return {
    taskId: task.id,
    stratum: task.stratum,
    fixturePath: fixture ? `${task.id}.json` : undefined,
    fixtureMissing: !fixture,
    claimEligible,
    expectedIndexSource: oracle.indexSource,
    actualIndexSource,
    indexSourceMatchesOracle,
    oracle,
    quality,
    noResult: isNoResult(combinedText),
    weakResult: quality?.signal === "weak",
    rawOutputChars: rawText.length,
    renderedBlockChars: renderedText.length,
    rawOutput: scoreSurface("rawOutput", rawText, oracle),
    renderedBlock: scoreSurface("renderedBlock", renderedText, oracle),
    leakage: {
      answerLeak,
      forbiddenTextFragments,
      forbiddenSymbols: leakedSymbols,
    },
    blockingFindings,
  };
}

export function aggregateLicRetrievalCases(
  cases: LicRetrievalCaseEvaluation[],
  options: { taskSet: string; generatedAt?: string } = { taskSet: "custom" },
): LicRetrievalEvalReport {
  const raw = aggregateSurface(cases.map((testCase) => testCase.rawOutput));
  const rendered = aggregateSurface(cases.map((testCase) => testCase.renderedBlock));
  const claimBlockingFindings = cases.flatMap((testCase) => testCase.blockingFindings);
  const qualityDistribution: Record<LicFixtureSignal | "missing", number> = {
    none: 0,
    weak: 0,
    medium: 0,
    strong: 0,
    leak: 0,
    missing: 0,
  };
  for (const testCase of cases) {
    if (!testCase.quality) {
      qualityDistribution.missing++;
    } else {
      qualityDistribution[testCase.quality.signal]++;
    }
  }

  return {
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    taskSet: options.taskSet,
    taskIds: cases.map((testCase) => testCase.taskId),
    caseCount: cases.length,
    fixtureCount: cases.filter((testCase) => !testCase.fixtureMissing).length,
    rawOutput: raw,
    renderedBlock: rendered,
    leakageInvariantFailures: cases.filter((testCase) => testCase.leakage.answerLeak).length,
    claimBlockingFindings,
    missingFixtures: cases.filter((testCase) => testCase.fixtureMissing).length,
    indexSourceFailures: cases.filter((testCase) => !testCase.fixtureMissing && !testCase.indexSourceMatchesOracle).length,
    noResultRate: rate(cases.filter((testCase) => testCase.noResult).length, cases.length),
    weakResultRate: rate(cases.filter((testCase) => testCase.weakResult).length, cases.length),
    meanRawOutputChars: mean(cases.map((testCase) => testCase.rawOutputChars)),
    meanRenderedBlockChars: mean(cases.map((testCase) => testCase.renderedBlockChars)),
    fixtureQualityDistribution: qualityDistribution,
    cases,
  };
}

export async function loadLicRetrievalFixtures(
  fixturesDir: string,
  taskIds?: Iterable<string>,
): Promise<Map<string, LicRetrievalFixture>> {
  const allowed = taskIds ? new Set(taskIds) : undefined;
  const out = new Map<string, LicRetrievalFixture>();
  const files = await readdir(fixturesDir);
  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    const taskId = file.slice(0, -".json".length);
    if (allowed && !allowed.has(taskId)) continue;
    const raw = await readFile(join(fixturesDir, file), "utf8");
    const fixture = JSON.parse(raw) as LicRetrievalFixture;
    out.set(fixture.taskId ?? taskId, fixture);
  }
  return out;
}

export function renderLicRetrievalMarkdown(report: LicRetrievalEvalReport): string {
  const lines: string[] = [];
  lines.push("# LIC Retrieval Eval");
  lines.push("");
  lines.push(`Generated: ${report.generatedAt}`);
  lines.push(`Task set: \`${report.taskSet}\``);
  lines.push(`Cases: ${report.caseCount}`);
  lines.push(`Fixtures: ${report.fixtureCount}`);
  lines.push(`Claim-blocking findings: ${report.claimBlockingFindings.length}`);
  lines.push("");
  lines.push("## Aggregate Metrics");
  lines.push("");
  lines.push("| surface | file recall | symbol recall | contract-evidence recall | mean chars |");
  lines.push("| --- | ---: | ---: | ---: | ---: |");
  lines.push(`| raw output | ${fmtRecall(report.rawOutput.fileRecall, report.rawOutput.fileHits, report.rawOutput.fileRequired)} | ${fmtRecall(report.rawOutput.symbolRecall, report.rawOutput.symbolHits, report.rawOutput.symbolRequired)} | ${fmtRecall(report.rawOutput.contractEvidenceRecall, report.rawOutput.contractEvidenceHits, report.rawOutput.contractEvidenceRequired)} | ${report.meanRawOutputChars.toFixed(1)} |`);
  lines.push(`| rendered block | ${fmtRecall(report.renderedBlock.fileRecall, report.renderedBlock.fileHits, report.renderedBlock.fileRequired)} | ${fmtRecall(report.renderedBlock.symbolRecall, report.renderedBlock.symbolHits, report.renderedBlock.symbolRequired)} | ${fmtRecall(report.renderedBlock.contractEvidenceRecall, report.renderedBlock.contractEvidenceHits, report.renderedBlock.contractEvidenceRequired)} | ${report.meanRenderedBlockChars.toFixed(1)} |`);
  lines.push("");
  lines.push("## Fixture Signals");
  lines.push("");
  lines.push("| signal | count | rate |");
  lines.push("| --- | ---: | ---: |");
  for (const signal of ["strong", "medium", "weak", "none", "leak", "missing"] as const) {
    const count = report.fixtureQualityDistribution[signal] ?? 0;
    lines.push(`| ${signal} | ${count} | ${fmtNumber(rate(count, report.caseCount))} |`);
  }
  lines.push("");
  lines.push(`No-result rate: ${fmtNumber(report.noResultRate)}`);
  lines.push(`Weak-result rate: ${fmtNumber(report.weakResultRate)}`);
  lines.push(`Leakage invariant failures: ${report.leakageInvariantFailures}`);
  lines.push(`Missing fixtures: ${report.missingFixtures}`);
  lines.push(`Index-source failures: ${report.indexSourceFailures}`);
  lines.push("");
  if (report.claimBlockingFindings.length > 0) {
    lines.push("## Claim-Blocking Findings");
    lines.push("");
    lines.push("| task | kind | message |");
    lines.push("| --- | --- | --- |");
    for (const finding of report.claimBlockingFindings) {
      lines.push(`| ${md(finding.taskId)} | ${finding.kind} | ${md(finding.message)} |`);
    }
    lines.push("");
  }
  lines.push("## Case Metrics");
  lines.push("");
  lines.push("| task | stratum | signal | index | raw files | raw symbols | raw contract | rendered files | rendered symbols | rendered contract | leak | chars raw/rendered |");
  lines.push("| --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- | ---: |");
  for (const testCase of report.cases) {
    lines.push([
      md(testCase.taskId),
      testCase.stratum ?? "",
      testCase.quality?.signal ?? "missing",
      md(formatIndexSource(testCase.actualIndexSource)),
      fmtItemRecall(testCase.rawOutput.files),
      fmtItemRecall(testCase.rawOutput.symbols),
      fmtItemRecall(testCase.rawOutput.contractEvidence),
      fmtItemRecall(testCase.renderedBlock.files),
      fmtItemRecall(testCase.renderedBlock.symbols),
      fmtItemRecall(testCase.renderedBlock.contractEvidence),
      testCase.leakage.answerLeak ? "yes" : "no",
      `${testCase.rawOutputChars}/${testCase.renderedBlockChars}`,
    ].join(" | ").replace(/^/, "| ").replace(/$/, " |"));
  }
  lines.push("");
  return `${lines.join("\n")}\n`;
}

function scoreSurface(
  surface: LicRetrievalSurface,
  text: string,
  oracle: LicRetrievalOracleCase,
): LicRetrievalSurfaceEvaluation {
  return {
    surface,
    charCount: text.length,
    files: scoreItems(oracle.requiredFiles, text),
    symbols: scoreItems(oracle.requiredSymbols, text),
    contractEvidence: scoreItems(oracle.contractEvidence ?? [], text),
  };
}

function scoreItems(items: string[], text: string): LicRetrievalItemRecall {
  const required = dedupe(items.filter((item) => item.trim().length > 0));
  const hits = hitsForItems(required, text);
  const hitSet = new Set(hits);
  return {
    required,
    hits,
    missing: required.filter((item) => !hitSet.has(item)),
    recall: required.length === 0 ? null : hits.length / required.length,
  };
}

function hitsForItems(items: string[], text: string): string[] {
  const normalizedText = normalizeForContainment(text);
  return dedupe(items.filter((item) => normalizedText.includes(normalizeForContainment(item))));
}

function aggregateSurface(surfaces: LicRetrievalSurfaceEvaluation[]): LicRetrievalAggregateSurface {
  const counters: AggregateCounters = {
    fileHits: 0,
    fileRequired: 0,
    symbolHits: 0,
    symbolRequired: 0,
    contractEvidenceHits: 0,
    contractEvidenceRequired: 0,
    casesWithFiles: 0,
    casesWithSymbols: 0,
    casesWithContractEvidence: 0,
  };
  for (const surface of surfaces) {
    addCounters(counters, "file", surface.files);
    addCounters(counters, "symbol", surface.symbols);
    addCounters(counters, "contractEvidence", surface.contractEvidence);
  }
  return {
    fileRecall: recall(counters.fileHits, counters.fileRequired),
    symbolRecall: recall(counters.symbolHits, counters.symbolRequired),
    contractEvidenceRecall: recall(counters.contractEvidenceHits, counters.contractEvidenceRequired),
    ...counters,
  };
}

function addCounters(
  counters: AggregateCounters,
  kind: "file" | "symbol" | "contractEvidence",
  itemRecall: LicRetrievalItemRecall,
): void {
  if (kind === "file") {
    counters.fileHits += itemRecall.hits.length;
    counters.fileRequired += itemRecall.required.length;
    if (itemRecall.required.length > 0) counters.casesWithFiles++;
  } else if (kind === "symbol") {
    counters.symbolHits += itemRecall.hits.length;
    counters.symbolRequired += itemRecall.required.length;
    if (itemRecall.required.length > 0) counters.casesWithSymbols++;
  } else {
    counters.contractEvidenceHits += itemRecall.hits.length;
    counters.contractEvidenceRequired += itemRecall.required.length;
    if (itemRecall.required.length > 0) counters.casesWithContractEvidence++;
  }
}

function rawOutputText(fixture: LicRetrievalFixture): string {
  const raw = (fixture.calls ?? [])
    .map((call) => call.output ?? "")
    .filter((output) => output.trim().length > 0)
    .join("\n");
  return raw.length > 0 ? raw : fixture.renderedBlock ?? "";
}

function expectedIndexSource(task: Task, fixture?: LicRetrievalFixture): LicIndexSource {
  const parentSha = task.provenance?.parentSha;
  if (parentSha) {
    const worktree =
      fixture?.indexSource?.kind === "parentSha" && fixture.indexSource.sha === parentSha
        ? fixture.indexSource.worktree
        : "";
    return { kind: "parentSha", sha: parentSha, worktree };
  }
  if (fixture?.indexSource) return fixture.indexSource;
  return { kind: "head", repo: "" };
}

function matchesIndexSource(expected: LicIndexSource, actual: LicIndexSource | undefined): boolean {
  if (!actual) return false;
  if (expected.kind !== actual.kind) return false;
  if (expected.kind === "parentSha") return actual.kind === "parentSha" && actual.sha === expected.sha;
  return actual.kind === "head";
}

function queryTextForMode(task: Task, fixture: LicRetrievalFixture | undefined, queryMode: LicRetrievalQueryMode): string {
  if (queryMode === "task-prompt") return task.prompt;
  if (queryMode === "lic-seed") return [task.licSeed?.investigateQuery, task.licSeed?.symbol].filter(Boolean).join(" ");
  if (queryMode === "oracle-symbols") return (task.kgExpectations?.requiredSymbols ?? []).join(" ");
  return inferFixtureQuery(fixture) || task.licSeed?.investigateQuery || task.licSeed?.symbol || task.prompt.split(/\r?\n/)[0] || "";
}

function inferFixtureQuery(fixture: LicRetrievalFixture | undefined): string {
  for (const call of fixture?.calls ?? []) {
    const args = call.args ?? [];
    for (let index = args.length - 1; index >= 0; index--) {
      const value = args[index];
      if (value && !value.startsWith("-") && !value.startsWith("/")) return value;
    }
  }
  return "";
}

function isFutureOrSyntheticTask(task: Task): boolean {
  return Boolean(
    task.tags?.includes("kg-derived") ||
    task.tags?.includes("future-emc") ||
    task.id.startsWith("future-") ||
    task.id.startsWith("synth-"),
  );
}

function isClaimEligibleTask(task: Task): boolean {
  return Boolean(!task.excluded && task.stratum && task.stratum !== "S6" && task.stratum !== "S7");
}

function isNoResult(text: string): boolean {
  if (!hasNoDefinitionSignal(text)) return false;
  if (hasPositiveSearchResults(text)) return false;
  return !(/\*\*file:\*\*/i.test(text) || /fqn:/i.test(text) || /^\s*\d+\.\s+\S+.*\(lines?\s+\d+/im.test(text));
}

function normalizeForContainment(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

function dedupe(values: string[]): string[] {
  return Array.from(new Set(values.filter((value) => value.trim().length > 0)));
}

function recall(hits: number, required: number): number | null {
  return required === 0 ? null : hits / required;
}

function rate(count: number, total: number): number {
  return total === 0 ? 0 : count / total;
}

function mean(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function fmtNumber(value: number | null): string {
  return value === null ? "n/a" : value.toFixed(3);
}

function fmtRecall(value: number | null, hits: number, required: number): string {
  if (value === null) return "n/a";
  return `${fmtNumber(value)} (${hits}/${required})`;
}

function fmtItemRecall(recallValue: LicRetrievalItemRecall): string {
  return fmtRecall(recallValue.recall, recallValue.hits.length, recallValue.required.length);
}

function md(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\r?\n/g, "<br>");
}

function formatIndexSource(source: LicIndexSource | undefined): string {
  if (!source) return "missing";
  if (source.kind === "parentSha") return `parent:${source.sha.slice(0, 12)}`;
  return "head";
}
