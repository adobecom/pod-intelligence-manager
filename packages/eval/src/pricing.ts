import type { RunUsage } from "./runners/types.js";

export interface ModelPricing {
  /** USD per 1M input tokens (uncached). */
  input: number;
  /** USD per 1M output tokens. */
  output: number;
  /** USD per 1M cache-creation tokens (5m TTL ephemeral). */
  cacheCreate: number;
  /** USD per 1M cache-read tokens. */
  cacheRead: number;
}

/**
 * Pricing as of 2026-Q1 from public Anthropic + AWS Bedrock pages.
 * Update when rates change; values are USD per 1M tokens.
 * Bedrock IDs are listed because the Converse API surfaces them as `model`.
 */
export const PRICING: Record<string, ModelPricing> = {
  // --- Anthropic API (claude-* short IDs) ---
  "claude-opus-4-7": { input: 15, output: 75, cacheCreate: 18.75, cacheRead: 1.5 },
  "claude-sonnet-4-6": { input: 3, output: 15, cacheCreate: 3.75, cacheRead: 0.3 },
  "claude-haiku-4-5": { input: 1, output: 5, cacheCreate: 1.25, cacheRead: 0.1 },
  "claude-3-5-sonnet-20241022": { input: 3, output: 15, cacheCreate: 3.75, cacheRead: 0.3 },
  "claude-3-5-haiku-20241022": { input: 0.8, output: 4, cacheCreate: 1.0, cacheRead: 0.08 },

  // --- Bedrock cross-region inference profile IDs (us.*) — same per-token rates as Anthropic API. ---
  "us.anthropic.claude-3-5-sonnet-20241022-v2:0": { input: 3, output: 15, cacheCreate: 3.75, cacheRead: 0.3 },
  "us.anthropic.claude-3-5-haiku-20241022-v1:0": { input: 0.8, output: 4, cacheCreate: 1.0, cacheRead: 0.08 },
  "us.anthropic.claude-sonnet-4-6": { input: 3, output: 15, cacheCreate: 3.75, cacheRead: 0.3 },
  "us.anthropic.claude-opus-4-7": { input: 15, output: 75, cacheCreate: 18.75, cacheRead: 1.5 },
  "us.anthropic.claude-haiku-4-5": { input: 1, output: 5, cacheCreate: 1.25, cacheRead: 0.1 },
};

export function priceFor(model: string): ModelPricing | null {
  return PRICING[model] ?? null;
}

export function costFor(model: string, usage: RunUsage): number {
  const p = priceFor(model);
  if (!p) return 0;
  return (
    (usage.inputTokens * p.input +
      usage.outputTokens * p.output +
      usage.cacheCreationTokens * p.cacheCreate +
      usage.cacheReadTokens * p.cacheRead) /
    1_000_000
  );
}
