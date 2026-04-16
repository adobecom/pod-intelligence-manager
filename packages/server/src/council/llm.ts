// Bedrock Converse API client — uses Claude via AWS Bedrock with Bearer token auth.
// Configure via env: AWS_REGION, AWS_BEARER_TOKEN_BEDROCK, BEDROCK_MODEL_FAST, BEDROCK_MODEL_SMART.

const DEFAULT_FAST = "us.anthropic.claude-3-5-haiku-20241022-v1:0";
const DEFAULT_SMART = "us.anthropic.claude-3-5-sonnet-20241022-v2:0";

export const MODELS = {
  get fast() {
    return process.env.BEDROCK_MODEL_FAST || DEFAULT_FAST;
  },
  get smart() {
    return process.env.BEDROCK_MODEL_SMART || DEFAULT_SMART;
  },
};

export type ModelId = string;

export function isLLMAvailable(): boolean {
  return !!process.env.AWS_BEARER_TOKEN_BEDROCK;
}

interface ConverseResponse {
  output?: { message?: { content?: Array<{ text?: string }> } };
}

export async function callLLM(opts: {
  model: ModelId;
  system: string;
  prompt: string;
  maxTokens?: number;
}): Promise<string> {
  const token = process.env.AWS_BEARER_TOKEN_BEDROCK;
  if (!token) throw new Error("AWS_BEARER_TOKEN_BEDROCK is not set");

  const region = process.env.AWS_REGION || "us-west-2";
  const url = `https://bedrock-runtime.${region}.amazonaws.com/model/${opts.model}/converse`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      system: [{ text: opts.system }],
      messages: [{ role: "user", content: [{ text: opts.prompt }] }],
      inferenceConfig: { maxTokens: opts.maxTokens ?? 2048 },
    }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(
      `Bedrock Converse failed: ${response.status} ${response.statusText} — ${body}`,
    );
  }

  const data = (await response.json()) as ConverseResponse;
  return data.output?.message?.content?.[0]?.text ?? "";
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
