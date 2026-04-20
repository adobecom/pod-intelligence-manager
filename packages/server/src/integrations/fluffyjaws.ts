import type { ContextSearchHit } from "@council/shared";
import { type IntegrationResult, type IntegrationSearchOpts, truncate } from "./types.js";

// Fluffyjaws is a conversational RAG API, not a REST search endpoint. The
// contract (as reverse-engineered from ~/.local/share/fj/fj.mjs v0.2.0):
//
//   POST /api/conversation/create   { temporary: true, fluffyPackUuid? } → { conversationUuid }
//   POST /api/stream                (OpenAI-style Responses SSE)
//
// Auth: Cookie header `fjv3_session=<sessionId>`. No Bearer token.
// Session id is stored locally at ~/.config/fj/session.json and can be
// refreshed with `fj login`. The server reads it from FLUFFYJAWS_SESSION_ID.
// The backend handles Okta token refresh transparently while the cookie is
// valid; on 401 we surface a clear "run fj login" reason.
//
// Output shape: Fluffyjaws always returns natural-language synthesis, never
// structured hits. We collect the streamed `response.output_text.delta` events
// into one ContextSearchHit tagged low_trust (consistent with the Victor
// guide's trust model for Fluffyjaws' RAG output).

const DEFAULT_BASE_URL = "https://api.fluffyjaws.adobe.com";
const DEFAULT_MODEL = "gpt-5.1";
// Wire-level reasoning effort per Foundry: none|minimal|low|medium|high|xhigh.
// Must be at least "low" — Fluffyjaws auto-attaches code_interpreter as a tool,
// which rejects "minimal". "medium" matches fj's default "thinking" CLI mode.
const DEFAULT_REASONING_EFFORT: string = "medium";
// Fluffyjaws streams reasoning + tool output before assistant text; at
// `medium` effort a cold conversation can take 60-90s. Allow 2 minutes.
const STREAM_TIMEOUT_MS = 120_000;

interface ConversationCreateResponse {
  conversationUuid?: string;
  conversation_uuid?: string;
  [k: string]: unknown;
}

function baseUrl(): string {
  // `||` not `??`: empty-string env values should fall through to the default.
  const raw = process.env.FLUFFYJAWS_BASE_URL || DEFAULT_BASE_URL;
  return raw.replace(/\/$/, "");
}

function cookieHeader(sessionId: string): string {
  return `fjv3_session=${sessionId}`;
}

async function createConversation(base: string, sessionId: string): Promise<string | null> {
  const res = await fetch(`${base}/api/conversation/create`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      Cookie: cookieHeader(sessionId),
    },
    body: JSON.stringify({ temporary: true }),
  });
  if (!res.ok) {
    throw new Error(`conversation/create ${res.status}: ${await res.text().catch(() => "")}`);
  }
  const data = (await res.json()) as ConversationCreateResponse;
  return data.conversationUuid ?? data.conversation_uuid ?? null;
}

function extractDeltaText(event: Record<string, unknown>): string {
  const delta = event.delta;
  if (typeof delta === "string") return delta;
  if (delta && typeof delta === "object") {
    const d = delta as Record<string, unknown>;
    if (typeof d.text === "string") return d.text;
    if (d.text && typeof d.text === "object") {
      const value = (d.text as Record<string, unknown>).value;
      if (typeof value === "string") return value;
    }
  }
  return "";
}

async function streamAssistantText(
  base: string,
  sessionId: string,
  query: string,
): Promise<string> {
  const payload: Record<string, unknown> = {
    model: DEFAULT_MODEL,
    canvasMode: false,
    webSearchEnabled: false,
    messages: [
      {
        role: "user",
        content: [{ type: "input_text", text: query }],
      },
    ],
  };
  if (DEFAULT_REASONING_EFFORT) payload.reasoningEffort = DEFAULT_REASONING_EFFORT;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), STREAM_TIMEOUT_MS);

  try {
    const res = await fetch(`${base}/api/stream`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "text/event-stream",
        Cookie: cookieHeader(sessionId),
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    if (res.status === 401) {
      throw new Error("401 unauthorized — run `fj login` to refresh FLUFFYJAWS_SESSION_ID");
    }
    if (!res.ok || !res.body) {
      throw new Error(`/api/stream ${res.status}: ${(await res.text().catch(() => "")).slice(0, 300)}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let assistantText = "";

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let sep: number;
      while ((sep = buffer.indexOf("\n\n")) !== -1) {
        const raw = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);

        for (const line of raw.split("\n")) {
          if (!line.startsWith("data:")) continue;
          const payload = line.slice(5).trim();
          if (!payload || payload === "[DONE]") continue;
          let event: Record<string, unknown>;
          try {
            event = JSON.parse(payload) as Record<string, unknown>;
          } catch {
            continue;
          }
          switch (event.type) {
            case "response.output_text.delta": {
              assistantText += extractDeltaText(event);
              break;
            }
            case "response.output_text.done": {
              if (typeof event.text === "string" && !assistantText.endsWith(event.text)) {
                // Use .done text only if we didn't already accumulate deltas for it.
                if (assistantText.length === 0) assistantText = event.text;
              }
              break;
            }
            default:
              // Ignore reasoning / tool / lifecycle events.
              break;
          }
        }
      }
    }

    return assistantText;
  } finally {
    clearTimeout(timer);
  }
}

function decorateQueryWithScope(opts: IntegrationSearchOpts): string {
  const parts: string[] = [];
  const r = opts.project_resources;
  if (opts.project_name || r) {
    const name = opts.project_name ? `"${opts.project_name}"` : "the configured project";
    const aliases = r?.aliases?.length ? ` (aliases: ${r.aliases.join(", ")})` : "";
    parts.push(`Scope: ${name}${aliases}.`);
  }
  if (opts.actor?.display_name || opts.actor?.email) {
    parts.push(
      `Person of interest: ${opts.actor.display_name ?? opts.actor.email}.`,
    );
  }
  parts.push(`Question: ${opts.query}`);
  return parts.join(" ");
}

export async function searchFluffyjaws(opts: IntegrationSearchOpts): Promise<IntegrationResult> {
  const sessionId = process.env.FLUFFYJAWS_SESSION_ID;
  if (!sessionId) {
    return {
      source: "fluffyjaws",
      hits: [],
      missing:
        "FLUFFYJAWS_SESSION_ID not set — copy `sessionId` from ~/.config/fj/session.json (or run `fj login`)",
    };
  }

  const base = baseUrl();

  try {
    await createConversation(base, sessionId);
    const scopedQuery = decorateQueryWithScope(opts);
    const text = await streamAssistantText(base, sessionId, scopedQuery);

    if (!text.trim()) {
      return { source: "fluffyjaws", hits: [], missing: "Fluffyjaws returned empty response" };
    }

    const hit: ContextSearchHit = {
      source: "fluffyjaws",
      title: "Fluffyjaws synthesis",
      url: base.replace(/^https:\/\/api\./, "https://"),
      snippet: truncate(text, 1200),
      timestamp: new Date().toISOString(),
      metadata: { low_trust: true, full_response_length: text.length },
    };

    return { source: "fluffyjaws", hits: [hit] };
  } catch (err) {
    return {
      source: "fluffyjaws",
      hits: [],
      missing: `Fluffyjaws error: ${(err as Error).message}`,
    };
  }
}
