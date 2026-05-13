import Anthropic from "@anthropic-ai/sdk";
import type { LLMRunner, PromptSegments, RunnerConfig, RunResult } from "./types.js";

const DEFAULT_MODEL = "claude-sonnet-4-6";

let _client: Anthropic | null = null;
function getClient(): Anthropic {
  if (_client) return _client;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error(
      "AnthropicRunner requires ANTHROPIC_API_KEY. Either set it or use BedrockRunner via AWS_BEARER_TOKEN_BEDROCK.",
    );
  }
  _client = new Anthropic({ apiKey });
  return _client;
}

export const anthropicRunner: LLMRunner = {
  name: "anthropic",
  async run(prompt: PromptSegments, config: RunnerConfig): Promise<RunResult> {
    const client = getClient();
    const model = config.model || DEFAULT_MODEL;

    const systemBlocks: Array<{ type: "text"; text: string; cache_control?: { type: "ephemeral" } }> = [
      // System prompt cached on its own breakpoint so control arm benefits too.
      { type: "text", text: prompt.system, cache_control: { type: "ephemeral" } },
    ];
    if (prompt.pimContext && prompt.pimContext.trim().length > 0) {
      // PIM context is the second cache breakpoint — same for every task on a given pod,
      // so subsequent calls within the same arm/pod reuse the cached prefix.
      systemBlocks.push({
        type: "text",
        text: prompt.pimContext,
        cache_control: { type: "ephemeral" },
      });
    }

    const t0 = Date.now();
    const response = await client.messages.create({
      model,
      max_tokens: config.maxOutputTokens ?? 2048,
      ...(config.temperature !== undefined ? { temperature: config.temperature } : {}),
      system: systemBlocks,
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: prompt.userTask }],
        },
      ],
    });
    const latencyMs = Date.now() - t0;

    const text = response.content
      .filter((block) => block.type === "text")
      .map((block) => (block as { type: "text"; text: string }).text)
      .join("");

    const u = response.usage;
    return {
      text,
      usage: {
        inputTokens: u.input_tokens ?? 0,
        outputTokens: u.output_tokens ?? 0,
        cacheReadTokens: (u as { cache_read_input_tokens?: number }).cache_read_input_tokens ?? 0,
        cacheCreationTokens: (u as { cache_creation_input_tokens?: number }).cache_creation_input_tokens ?? 0,
      },
      latencyMs,
      model,
      runner: "anthropic",
    };
  },
};
