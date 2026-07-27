import crypto from "node:crypto";
import type { KnowledgeNode } from "@pim/shared";

const DEFAULT_DIMENSIONS = 512;
const VALID_DIMENSIONS = new Set([256, 512, 1024]);
const EMBED_DELAY_MS = 1100; // ~1 req/sec to stay within Bedrock rate limits

export function isEmbeddingAvailable(): boolean {
  return !!(process.env.AWS_BEARER_TOKEN_BEDROCK && process.env.AWS_REGION);
}

export function getEmbeddingDimensions(): number {
  const raw = parseInt(process.env.EMBEDDING_DIMENSIONS ?? "", 10);
  return VALID_DIMENSIONS.has(raw) ? raw : DEFAULT_DIMENSIONS;
}

/** Produces the text fed to the embedding model for a given node. */
export function embedText(node: Pick<KnowledgeNode, "summary" | "details" | "retrieval_text">): string {
  const retrievalText = node.retrieval_text?.trim();
  if (retrievalText) return retrievalText;
  const details = node.details?.trim();
  return details ? `${node.summary}. ${details}` : node.summary;
}

export function embeddingTextHash(text: string): string {
  return crypto.createHash("sha256").update(text).digest("hex");
}

const BEDROCK_TIMEOUT_MS = 8_000;

/**
 * Calls Amazon Titan Text Embeddings v2 via the Bedrock `/invoke` endpoint.
 *
 * Unlike `generateEmbedding`, this strict variant never converts an embedding
 * failure into a successful-looking null result. Catalog indexing uses this
 * path so failed blobs remain retryable instead of being marked ready.
 */
export async function generateEmbeddingStrict(text: string): Promise<number[]> {
  if (!isEmbeddingAvailable()) {
    throw new Error(
      "Bedrock embeddings are unavailable: AWS_BEARER_TOKEN_BEDROCK and AWS_REGION are required",
    );
  }

  const region = process.env.AWS_REGION!;
  const token = process.env.AWS_BEARER_TOKEN_BEDROCK!;
  const dimensions = getEmbeddingDimensions();

  const url = `https://bedrock-runtime.${region}.amazonaws.com/model/amazon.titan-embed-text-v2:0/invoke`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), BEDROCK_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ inputText: text, dimensions, normalize: true }),
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(
        `Bedrock request failed: ${response.status} ${response.statusText}`,
      );
    }

    const data = (await response.json()) as unknown;
    const embedding =
      typeof data === "object" && data !== null
        ? (data as { embedding?: unknown }).embedding
        : undefined;
    if (
      !Array.isArray(embedding) ||
      embedding.length !== dimensions ||
      !embedding.every(
        (value): value is number =>
          typeof value === "number" && Number.isFinite(value),
      )
    ) {
      throw new Error(
        `Bedrock returned an invalid embedding; expected ${dimensions} finite dimensions`,
      );
    }
    return embedding;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Best-effort embedding path used by knowledge-graph and search recall.
 * Returns null (silently) when the service is not configured and degrades to
 * null, with a warning, for every Bedrock failure.
 */
export async function generateEmbedding(text: string): Promise<number[] | null> {
  if (!isEmbeddingAvailable()) return null;

  try {
    return await generateEmbeddingStrict(text);
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      console.warn(
        `[embeddings] Bedrock timed out after ${BEDROCK_TIMEOUT_MS}ms — falling back to keyword scoring`,
      );
    } else if (
      err instanceof Error &&
      err.message.startsWith("Bedrock request failed:")
    ) {
      console.warn(`[embeddings] ${err.message}`);
    } else {
      console.warn("[embeddings] Embedding generation failed:", err);
    }
    return null;
  }
}

/**
 * Cosine similarity between two equal-length float vectors.
 * Returns 0 for zero vectors or mismatched lengths.
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

/**
 * Embeds all nodes that lack an `embedding` field or have a stale source-text hash,
 * rate-limited to ~1 req/sec.
 * Calls `onBatchSave` every 10 nodes so the graph is persisted incrementally.
 */
export async function batchEmbedWithRateLimit(
  nodes: KnowledgeNode[],
  onBatchSave: () => void,
  delayMs = EMBED_DELAY_MS,
): Promise<void> {
  const stale = nodes.filter((n) => !n.embedding || n.embedding_text_hash !== embeddingTextHash(embedText(n)));
  if (stale.length === 0) return;

  console.log(`[embeddings] Backfilling or refreshing ${stale.length} stale node embeddings...`);
  let processed = 0;
  const BATCH_SIZE = 10;

  for (let i = 0; i < stale.length; i++) {
    const node = stale[i];
    const text = embedText(node);
    const embedding = await generateEmbedding(text);
    if (embedding) {
      node.embedding = embedding;
      node.embedding_text_hash = embeddingTextHash(text);
    }
    processed++;

    if (processed % BATCH_SIZE === 0) {
      onBatchSave();
      console.log(`[embeddings] Backfill progress: ${processed}/${stale.length}`);
    }

    // Rate-limit between requests, but not after the last one
    if (i < stale.length - 1) {
      await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
    }
  }

  if (processed % BATCH_SIZE !== 0) onBatchSave();
  console.log(`[embeddings] Backfill complete (${processed} nodes processed)`);
}
