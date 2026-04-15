import Anthropic from "@anthropic-ai/sdk";

// Centralized model IDs — change here to upgrade across all agents
export const MODELS = {
  fast: "claude-haiku-4-5-20251001",
  smart: "claude-sonnet-4-5-20250514",
} as const;

export type ModelId = (typeof MODELS)[keyof typeof MODELS];

let client: Anthropic | null = null;

export function isLLMAvailable(): boolean {
  return !!process.env.ANTHROPIC_API_KEY;
}

function getClient(): Anthropic {
  if (!client) {
    client = new Anthropic();
  }
  return client;
}

export async function callLLM(opts: {
  model: ModelId;
  system: string;
  prompt: string;
  maxTokens?: number;
}): Promise<string> {
  const anthropic = getClient();

  const message = await anthropic.messages.create({
    model: opts.model,
    max_tokens: opts.maxTokens ?? 2048,
    system: opts.system,
    messages: [{ role: "user", content: opts.prompt }],
  });

  const block = message.content[0];
  if (block.type === "text") {
    return block.text;
  }
  return "";
}

export async function callLLMJSON<T>(opts: {
  model: ModelId;
  system: string;
  prompt: string;
  maxTokens?: number;
}): Promise<T | null> {
  const raw = await callLLM(opts);

  // Extract JSON from the response (may be wrapped in markdown code blocks)
  const jsonMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/) ?? raw.match(/(\{[\s\S]*\})/);
  if (!jsonMatch) return null;

  try {
    return JSON.parse(jsonMatch[1]) as T;
  } catch {
    return null;
  }
}
