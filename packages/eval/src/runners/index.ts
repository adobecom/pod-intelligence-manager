import type { LLMRunner, RunnerName } from "./types.js";
import { bedrockRunner } from "./bedrock.js";
import { anthropicRunner } from "./anthropic.js";

export function getRunner(name: RunnerName): LLMRunner {
  if (name === "bedrock") return bedrockRunner;
  if (name === "anthropic") return anthropicRunner;
  throw new Error(`Unknown runner: ${name}`);
}

/**
 * Pick a default runner based on which credentials are present.
 * Bedrock is preferred when both are set (matches the project's primary stack).
 */
export function pickDefaultRunner(): LLMRunner {
  if (process.env.AWS_BEARER_TOKEN_BEDROCK) return bedrockRunner;
  if (process.env.ANTHROPIC_API_KEY) return anthropicRunner;
  throw new Error(
    "No LLM credentials configured. Set AWS_BEARER_TOKEN_BEDROCK (Bedrock) or ANTHROPIC_API_KEY (direct Anthropic).",
  );
}

export { bedrockRunner, anthropicRunner };
export type { LLMRunner, RunnerName, RunnerConfig, RunResult, PromptSegments, RunUsage } from "./types.js";
