import type { LicContextFixture } from "../arms/types.js";
import type { Task } from "../tasks/types.js";

export type LicFixtureSignal = "none" | "weak" | "medium" | "strong" | "leak";

export interface LicFixtureQuality {
  signal: LicFixtureSignal;
  noDefinitionResult: boolean;
  answerLeak: boolean;
  intentMatch: boolean;
  primaryFileRetrieved: boolean;
  groundTruthSymbolOrChunkRetrieved: boolean;
  notes?: string[];
}

const STOPWORDS = new Set([
  "about",
  "after",
  "against",
  "also",
  "and",
  "are",
  "because",
  "before",
  "between",
  "but",
  "can",
  "code",
  "does",
  "event",
  "fix",
  "for",
  "from",
  "has",
  "have",
  "how",
  "into",
  "issue",
  "its",
  "not",
  "only",
  "should",
  "task",
  "that",
  "the",
  "this",
  "to",
  "use",
  "when",
  "with",
]);

const COMMON_IDENTIFIERS = new Set([
  "const",
  "export",
  "false",
  "function",
  "import",
  "interface",
  "return",
  "string",
  "true",
  "undefined",
]);

export function deriveLicFixtureQuality(task: Task, fixture: LicContextFixture): LicFixtureQuality {
  const rendered = fixture.renderedBlock ?? "";
  const text = normalize(rendered);
  const notes: string[] = [];

  const primaryFiles = extractGroundTruthFiles(task.groundTruth?.output ?? "");
  const primaryFileRetrieved = primaryFiles.some((file) => text.includes(normalize(file)));
  if (primaryFileRetrieved) notes.push("primary file retrieved");

  const noDefinitionResult = hasNoDefinitionSignal(rendered);
  if (noDefinitionResult) notes.push("symbol lookup returned no definition/no results");

  const groundTruthChunks = extractGroundTruthChunks(task.groundTruth?.output ?? "");
  const chunkLeak = groundTruthChunks.some((chunk) => text.includes(normalize(chunk)));

  const { symbols: groundTruthSymbols, leakedSymbols } = extractGroundTruthSymbols(task, rendered);
  const symbolHit = groundTruthSymbols.some((symbol) => text.includes(normalize(symbol)));
  const groundTruthSymbolOrChunkRetrieved = chunkLeak || symbolHit;
  if (symbolHit) notes.push(`ground-truth symbol retrieved: ${groundTruthSymbols.filter((s) => text.includes(normalize(s))).slice(0, 5).join(", ")}`);
  if (chunkLeak) notes.push("ground-truth text chunk retrieved");

  const answerLeak = chunkLeak || leakedSymbols.length > 0;
  if (leakedSymbols.length > 0) notes.push(`post-merge answer symbol leak: ${leakedSymbols.slice(0, 5).join(", ")}`);

  const intentMatch = hasIntentMatch(task, rendered, fixture);
  if (intentMatch) notes.push("task intent matched");

  const hasUsefulResult = hasPositiveSearchResults(rendered) || /\*\*file:\*\*/i.test(rendered) || /fqn:/i.test(rendered);
  const hasStructuralEvidence = /references|top callers|call-graph|callers|callees|impact|fqn:/i.test(rendered);
  const genericQuery = isGenericQuery(task, fixture);

  let signal: LicFixtureSignal;
  if (answerLeak) {
    signal = "leak";
  } else if (!hasUsefulResult && !primaryFileRetrieved && (noDefinitionResult || genericQuery)) {
    signal = "none";
  } else if (!primaryFileRetrieved && (noDefinitionResult || !symbolHit)) {
    signal = "weak";
  } else if (primaryFileRetrieved && (symbolHit || hasStructuralEvidence)) {
    signal = "strong";
  } else if (intentMatch || primaryFileRetrieved) {
    signal = "medium";
  } else {
    signal = "weak";
  }

  return {
    signal,
    noDefinitionResult,
    answerLeak,
    intentMatch,
    primaryFileRetrieved,
    groundTruthSymbolOrChunkRetrieved,
    ...(notes.length > 0 ? { notes } : {}),
  };
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

function tokenize(value: string): string[] {
  return Array.from(new Set(
    normalize(value)
      .split(/[^a-z0-9_/$.-]+/i)
      .filter((token) => token.length >= 4 && !STOPWORDS.has(token)),
  ));
}

function hasNoDefinitionSignal(text: string): boolean {
  if (text.trim().length === 0) return true;
  return (
    /\(no output\)/i.test(text) ||
    /no definition/i.test(text) ||
    /definition not found/i.test(text) ||
    /symbol not found/i.test(text) ||
    /found\s+0\s+results/i.test(text) ||
    /0 chunks reference this symbol/i.test(text)
  );
}

function hasPositiveSearchResults(text: string): boolean {
  for (const match of text.matchAll(/found\s+(\d+)\s+results/gi)) {
    if (Number(match[1]) > 0) return true;
  }
  return false;
}

function hasIntentMatch(task: Task, rendered: string, fixture: LicContextFixture): boolean {
  const text = normalize(rendered);
  const queryTokens = tokenize(task.licSeed?.investigateQuery ?? "");
  if (queryTokens.length > 0 && queryTokens.filter((token) => text.includes(token)).length >= Math.min(2, queryTokens.length)) {
    return true;
  }

  const promptHead = task.prompt.split(/\r?\n/).slice(0, 8).join(" ");
  const promptTokens = tokenize(promptHead).filter((token) => !["please", "write"].includes(token));
  if (promptTokens.filter((token) => text.includes(token)).length >= 3) return true;

  const recipeText = (fixture.recipe ?? []).join(" ");
  return queryTokens.some((token) => normalize(recipeText).includes(token));
}

function isGenericQuery(task: Task, fixture: LicContextFixture): boolean {
  const query = task.licSeed?.investigateQuery ?? inferQueryFromCalls(fixture);
  const tokens = tokenize(query);
  return tokens.length <= 1;
}

function inferQueryFromCalls(fixture: LicContextFixture): string {
  const calls = (fixture as LicContextFixture & { calls?: Array<{ args?: string[] }> }).calls ?? [];
  for (const call of calls) {
    const args = call.args ?? [];
    const last = args[args.length - 1];
    if (last && !last.startsWith("-") && !last.startsWith("/")) return last;
  }
  return "";
}

function extractGroundTruthFiles(groundTruth: string): string[] {
  const files = new Set<string>();
  for (const line of groundTruth.split(/\r?\n/)) {
    const diff = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
    if (diff) {
      files.add(diff[1]);
      files.add(diff[2]);
    }
    const plus = /^\+\+\+ b\/(.+)$/.exec(line);
    if (plus && plus[1] !== "/dev/null") files.add(plus[1]);
    const minus = /^--- a\/(.+)$/.exec(line);
    if (minus && minus[1] !== "/dev/null") files.add(minus[1]);
  }
  return Array.from(files);
}

function extractGroundTruthChunks(groundTruth: string): string[] {
  const normalized = groundTruth.replace(/\s+/g, " ").trim();
  if (normalized.length < 120) return [];
  const chunks: string[] = [];
  for (let i = 0; i < normalized.length; i += 160) {
    const chunk = normalized.slice(i, i + 160).trim();
    if (chunk.length >= 100) chunks.push(chunk);
  }
  return chunks;
}

function extractGroundTruthSymbols(task: Task, rendered: string): { symbols: string[]; leakedSymbols: string[] } {
  const promptSymbols = new Set(extractIdentifiers(task.prompt));
  const allowedSymbols = new Set([
    ...promptSymbols,
    ...extractIdentifiers(task.licSeed?.symbol ?? ""),
    ...extractIdentifiers(task.licSeed?.investigateQuery ?? ""),
    ...extractGroundTruthFiles(task.groundTruth?.output ?? "").flatMap(extractIdentifiers),
    ...(task.expectedSignals ?? []).flatMap(extractIdentifiers),
  ].map((s) => s.toLowerCase()));

  const symbols = extractIdentifiers(task.groundTruth?.output ?? "")
    .filter((symbol) => !allowedSymbols.has(symbol.toLowerCase()))
    .slice(0, 50);

  const text = normalize(rendered);
  const leakedSymbols = symbols.filter((symbol) => isLikelyAnswerSymbol(symbol) && text.includes(normalize(symbol)));
  return { symbols, leakedSymbols };
}

function extractIdentifiers(text: string): string[] {
  const out = new Set<string>();
  for (const match of text.matchAll(/\b[A-Za-z_$][A-Za-z0-9_$]{4,}\b/g)) {
    const symbol = match[0];
    if (COMMON_IDENTIFIERS.has(symbol.toLowerCase())) continue;
    out.add(symbol);
  }
  return Array.from(out);
}

function isLikelyAnswerSymbol(symbol: string): boolean {
  return symbol.length >= 10 || /[a-z][A-Z]/.test(symbol) || /[A-Z][a-z]+[A-Z]/.test(symbol);
}
