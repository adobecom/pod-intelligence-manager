/**
 * Shared LLM synthesis layer for search results.
 *
 * Both live (context search) and indexed (project search) synthesis calls
 * share the same underlying mechanics: load a system prompt from disk, build
 * a JSON evidence envelope, call MODELS.fast, return trimmed markdown.
 *
 * Mode-specific behaviour stays in the caller:
 * - Which prompt file to load (context-search-synthesis.md vs project-search-synthesis.md).
 * - How to shape the evidence object (hits vs ranked artifacts with ref tokens).
 * - The maximum token budget.
 *
 * Each prompt file is loaded once and cached for the lifetime of the process.
 */
import fs from "node:fs";
import { callLLM, isLLMAvailable, MODELS } from "../../pim/llm.js";

const promptCache = new Map<string, string>();

/** Load a synthesis prompt file, falling back to a minimal default on error.
 *  Results are cached so the file is read at most once per process. */
export function loadPromptFile(promptPath: string): string {
  const cached = promptCache.get(promptPath);
  if (cached !== undefined) return cached;
  let text: string;
  try {
    text = fs.readFileSync(promptPath, "utf-8");
  } catch {
    text = "Synthesize the following search results into a concise, citable markdown summary.";
  }
  promptCache.set(promptPath, text);
  return text;
}

export interface SynthesizeSearchOpts {
  /** Absolute path to the system-prompt .md file. */
  systemPromptPath: string;
  /** Serialisable evidence to pass as the user message (JSON-stringified). */
  evidence: unknown;
  /** Maximum tokens for the LLM response (default: 1200). */
  maxTokens?: number;
  /** Label used in error log lines, e.g. "context-search" or "project-search". */
  label?: string;
}

/** Run an LLM synthesis pass over search evidence.
 *  Returns the trimmed markdown string, or `undefined` if no LLM is
 *  available or if the call fails. Never throws.
 */
export async function synthesizeSearch(opts: SynthesizeSearchOpts): Promise<string | undefined> {
  if (!isLLMAvailable()) return undefined;
  const system = loadPromptFile(opts.systemPromptPath);
  try {
    const prompt = JSON.stringify(opts.evidence, null, 2);
    const md = await callLLM({
      model: MODELS.fast,
      system,
      prompt,
      maxTokens: opts.maxTokens ?? 1200,
    });
    return md.trim() || undefined;
  } catch {
    // Model-provider errors can echo request content. Keep logs code-only.
    console.error(`[search/synthesizer] synthesis failed (${opts.label ?? "unknown"})`);
    return undefined;
  }
}
