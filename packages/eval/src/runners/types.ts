export interface RunnerConfig {
  model: string;
  maxOutputTokens?: number;
  temperature?: number;
}

export interface PromptSegments {
  /** Stable across calls within the same arm/task-type. Cacheable. */
  system: string;
  /** Stable per pod within the treatment arm. Empty/undefined for control. Cacheable. */
  pimContext?: string;
  /** The task-specific user message. Uncached. */
  userTask: string;
}

export interface RunUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

export interface RunResult {
  text: string;
  usage: RunUsage;
  latencyMs: number;
  model: string;
  runner: RunnerName;
}

export type RunnerName = "bedrock" | "anthropic";

export interface LLMRunner {
  readonly name: RunnerName;
  run(prompt: PromptSegments, config: RunnerConfig): Promise<RunResult>;
}

export const EMPTY_USAGE: RunUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
};
