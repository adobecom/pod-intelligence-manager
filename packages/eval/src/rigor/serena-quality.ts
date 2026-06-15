import type { SerenaContextFixture, SerenaFixtureQuality, SerenaFixtureSignal, SerenaToolCall } from "../serena/types.js";
import type { Task } from "../tasks/types.js";
import {
  extractGroundTruthChunks,
  extractGroundTruthFiles,
  extractGroundTruthSymbols,
  extractIdentifiers,
} from "./lic-quality.js";
import { isSerenaErrorOutput } from "../serena/render.js";

/**
 * Serena fixture quality, parallel to `lic-quality.ts`. The leakage primitives
 * (ground-truth file/chunk/symbol extraction) are shared with LIC so the two
 * code-intelligence providers are held to the same anti-leakage bar. The
 * evidence signals are Serena-specific: they read the structured tool calls
 * (find_symbol / find_referencing_symbols / diagnostics) rather than guessing
 * from a flat search blob.
 */

export const SERENA_READY_SIGNALS = new Set<SerenaFixtureSignal>(["medium", "strong"]);

export function isSerenaFixtureQualityReady(quality: SerenaFixtureQuality | undefined): boolean {
  return Boolean(quality && SERENA_READY_SIGNALS.has(quality.signal));
}

export function describeSerenaFixtureQualityGate(taskId: string, quality: SerenaFixtureQuality | undefined): string {
  if (!quality) return `serena fixture for ${taskId} is missing quality metadata`;
  if (isSerenaFixtureQualityReady(quality)) return "";
  return `serena fixture for ${taskId} has signal=${quality.signal}; runnable Serena fixtures must be medium/strong`;
}

const SYMBOL_TOOLS = new Set([
  "find_symbol",
  "get_symbols_overview",
  "find_declaration",
  "find_implementations",
]);
const REFERENCE_TOOLS = new Set(["find_referencing_symbols"]);
const DIAGNOSTIC_TOOLS = new Set(["get_diagnostics_for_file", "get_diagnostics_for_symbol"]);

const STOPWORDS = new Set([
  "about", "after", "against", "also", "and", "are", "because", "before", "between",
  "but", "can", "code", "does", "event", "fix", "for", "from", "has", "have", "how",
  "into", "issue", "its", "not", "only", "should", "task", "that", "this", "the",
  "to", "use", "when", "with",
]);

function normalize(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

function tokenize(value: string): string[] {
  return Array.from(
    new Set(
      normalize(value)
        .split(/[^a-z0-9_/$.-]+/i)
        .filter((token) => token.length >= 4 && !STOPWORDS.has(token)),
    ),
  );
}

/** A tool call that ran and returned at least one result, not an empty/"not found"/error reply. */
function callHasResult(call: SerenaToolCall): boolean {
  if (!call.ok) return false;
  const out = (call.output ?? "").trim();
  if (out.length === 0) return false;
  if (isSerenaErrorOutput(out)) return false;
  if (out === "[]" || out === "{}" || out === "null") return false;
  if (
    /no (symbols?|results?|references?|matches?|definitions?|implementations?) (found|available)/i.test(out) ||
    /not found/i.test(out) ||
    /symbol .* could not be located/i.test(out) ||
    /0 references/i.test(out)
  ) {
    return false;
  }
  return true;
}

export function deriveSerenaFixtureQuality(task: Task, fixture: SerenaContextFixture): SerenaFixtureQuality {
  const rendered = fixture.renderedBlock ?? "";
  const text = normalize(rendered);
  const notes: string[] = [];
  const calls = fixture.calls ?? [];

  // Evidence signals — derived ONLY from successful structured tool calls. A loose
  // renderedBlock regex would false-positive on error text (e.g. a validation error
  // echoing "name_path"), so evidence must come from calls that actually returned.
  const symbolEvidenceRetrieved = calls.some((c) => SYMBOL_TOOLS.has(c.tool) && callHasResult(c));
  if (symbolEvidenceRetrieved) notes.push("symbol evidence retrieved");

  const referencesRetrieved = calls.some((c) => REFERENCE_TOOLS.has(c.tool) && callHasResult(c));
  if (referencesRetrieved) notes.push("references retrieved");

  const diagnosticsCaptured = calls.some((c) => DIAGNOSTIC_TOOLS.has(c.tool) && c.ok);
  if (diagnosticsCaptured) notes.push("diagnostics captured");

  // Evidence text = successful tool OUTPUTS only. We deliberately exclude the
  // rendered seed/provenance header and tool-call args, because those echo our own
  // seed symbols — matching against them produced false leaks (e.g. ground-truth
  // "acknowledged" being a substring of the seed "metadataFieldAcknowledged").
  const evidenceText = normalize(calls.filter(callHasResult).map((c) => c.output).join("\n"));

  const primaryFiles = extractGroundTruthFiles(task.groundTruth?.output ?? "");
  const primaryFileRetrieved = primaryFiles.some((file) => evidenceText.includes(normalize(file)));
  if (primaryFileRetrieved) notes.push("primary file retrieved");

  // Leak detection only applies to a HEAD index. A parent-SHA worktree is the
  // pre-merge tree, so it physically cannot contain post-merge answer code —
  // any overlap is a pre-existing symbol, not a leak (this is the same temporal
  // guarantee the worktree freeze policy relies on).
  const indexIsHead = fixture.indexSource?.kind !== "parentSha";
  const groundTruthChunks = extractGroundTruthChunks(task.groundTruth?.output ?? "");
  const chunkLeak = indexIsHead && groundTruthChunks.some((chunk) => evidenceText.includes(normalize(chunk)));
  const leakedSymbols = indexIsHead ? extractGroundTruthSymbols(task, evidenceText).leakedSymbols : [];
  const answerLeak = chunkLeak || leakedSymbols.length > 0;
  if (chunkLeak) notes.push("ground-truth text chunk retrieved");
  if (leakedSymbols.length > 0) notes.push(`post-merge answer symbol leak: ${leakedSymbols.slice(0, 5).join(", ")}`);

  const intentMatch = hasIntentMatch(task, evidenceText, fixture);
  if (intentMatch) notes.push("task intent matched");

  const hasSeed = fixture.seed.source !== "none" && (fixture.seed.symbols.length > 0 || (fixture.seed.files?.length ?? 0) > 0);
  if (!hasSeed) notes.push("no symbol/file seed available");

  let signal: SerenaFixtureSignal;
  if (answerLeak) {
    signal = "leak";
  } else if (!hasSeed && !symbolEvidenceRetrieved && !primaryFileRetrieved) {
    signal = "none";
  } else if (primaryFileRetrieved && symbolEvidenceRetrieved && (referencesRetrieved || diagnosticsCaptured)) {
    signal = "strong";
  } else if (symbolEvidenceRetrieved && referencesRetrieved) {
    signal = "strong";
  } else if (symbolEvidenceRetrieved || primaryFileRetrieved) {
    signal = "medium";
  } else if (intentMatch || referencesRetrieved || diagnosticsCaptured) {
    signal = "weak";
  } else {
    signal = "none";
  }

  return {
    signal,
    answerLeak,
    primaryFileRetrieved,
    symbolEvidenceRetrieved,
    referencesRetrieved,
    diagnosticsCaptured,
    intentMatch,
    notes,
  };
}

function hasIntentMatch(task: Task, rendered: string, fixture: SerenaContextFixture): boolean {
  const text = normalize(rendered);
  const queryTokens = tokenize(fixture.seed.naturalLanguageQuery ?? task.licSeed?.investigateQuery ?? "");
  if (queryTokens.length > 0 && queryTokens.filter((t) => text.includes(t)).length >= Math.min(2, queryTokens.length)) {
    return true;
  }
  const promptHead = task.prompt.split(/\r?\n/).slice(0, 8).join(" ");
  const promptTokens = tokenize(promptHead).filter((t) => !["please", "write"].includes(t));
  if (promptTokens.filter((t) => text.includes(t)).length >= 3) return true;
  const seedSymbols = [...fixture.seed.symbols, ...(fixture.seed.files ?? [])]
    .flatMap(extractIdentifiers)
    .map((s) => s.toLowerCase());
  return seedSymbols.some((s) => text.includes(s));
}
