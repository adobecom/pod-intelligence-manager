import type { LLMRunner, PromptSegments, RunnerConfig, RunResult } from "./types.js";

interface ConverseSystemBlock {
  text?: string;
  cachePoint?: { type: "default" };
}

interface ConverseResponse {
  output?: { message?: { content?: Array<{ text?: string }> } };
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
    cacheReadInputTokens?: number;
    cacheWriteInputTokens?: number;
  };
}

const DEFAULT_MODEL = "us.anthropic.claude-3-5-sonnet-20241022-v2:0";

export const bedrockRunner: LLMRunner = {
  name: "bedrock",
  async run(prompt: PromptSegments, config: RunnerConfig): Promise<RunResult> {
    const token = process.env.AWS_BEARER_TOKEN_BEDROCK;
    if (!token) {
      throw new Error(
        "BedrockRunner requires AWS_BEARER_TOKEN_BEDROCK. Either set it or use AnthropicRunner via ANTHROPIC_API_KEY.",
      );
    }
    const region = process.env.AWS_REGION || "us-west-2";
    const model = config.model || DEFAULT_MODEL;
    const url = `https://bedrock-runtime.${region}.amazonaws.com/model/${encodeURIComponent(model)}/converse`;

    const system: ConverseSystemBlock[] = [{ text: prompt.system }];
    if (prompt.pimContext && prompt.pimContext.trim().length > 0) {
      system.push({ text: prompt.pimContext });
      // Cache breakpoint after the (stable) PIM context so subsequent calls
      // for the same pod/system reuse the cached prefix.
      system.push({ cachePoint: { type: "default" } });
    } else {
      // Cache the system prompt alone in the control arm for fairness on repeat runs.
      system.push({ cachePoint: { type: "default" } });
    }

    const body = {
      system,
      messages: [
        {
          role: "user",
          content: [{ text: prompt.userTask }],
        },
      ],
      inferenceConfig: {
        maxTokens: config.maxOutputTokens ?? 2048,
        ...(config.temperature !== undefined ? { temperature: config.temperature } : {}),
      },
    };

    const t0 = Date.now();
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    });
    const latencyMs = Date.now() - t0;

    if (!response.ok) {
      const errBody = await response.text().catch(() => "");
      throw new Error(`Bedrock Converse failed (${response.status}): ${errBody.slice(0, 500)}`);
    }

    const data = (await response.json()) as ConverseResponse;
    const text = data.output?.message?.content?.[0]?.text ?? "";
    const u = data.usage ?? {};

    return {
      text,
      usage: {
        inputTokens: u.inputTokens ?? 0,
        outputTokens: u.outputTokens ?? 0,
        cacheReadTokens: u.cacheReadInputTokens ?? 0,
        cacheCreationTokens: u.cacheWriteInputTokens ?? 0,
      },
      latencyMs,
      model,
      runner: "bedrock",
    };
  },
};
