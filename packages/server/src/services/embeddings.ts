import type { KnowledgeNode } from "@pim/shared";

const DEFAULT_DIMENSIONS = 512;
const VALID_DIMENSIONS = new Set([256, 512, 1024]);
const EMBED_DELAY_MS = 1100; // ~1 req/sec to stay within Bedrock rate limits

export function isEmbeddingAvailable(): boolean {
  return !!(process.env.AWS_BEARER_TOKEN_BEDROCK && process.env.AWS_REGION);
}

function getEmbeddingDimensions(): number {
  const raw = parseInt(process.env.EMBEDDING_DIMENSIONS ?? "", 10);
  return VALID_DIMENSIONS.has(raw) ? raw : DEFAULT_DIMENSIONS;
}

/** Produces the text fed to the embedding model for a given node. */
export function embedText(node: Pick<KnowledgeNode, "summary" | "details">): string {
  const details = node.details?.trim();
  return details ? `${node.summary}. ${details}` : node.summary;
}

/**
 * Calls Amazon Titan Text Embeddings v2 via the Bedrock `/invoke` endpoint.
 * Returns null (silently) when the embedding service is unavailable or errors.
 */
export async function generateEmbedding(text: string): Promise<number[] | null> {
  if (!isEmbeddingAvailable()) return null;

  const region = process.env.AWS_REGION!;
  const token = process.env.AWS_BEARER_TOKEN_BEDROCK!;
  const dimensions = getEmbeddingDimensions();

  const url = `https://bedrock-runtime.${region}.amazonaws.com/model/amazon.titan-embed-text-v2:0/invoke`;

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ inputText: text, dimensions, normalize: true }),
    });

    if (!response.ok) {
      console.warn(`[embeddings] Bedrock request failed: ${response.status} ${response.statusText}`);
      return null;
    }

    const data = (await response.json()) as { embedding?: number[] };
    return data.embedding ?? null;
  } catch (err) {
    console.warn("[embeddings] Embedding generation failed:", err);
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
 * Embeds all nodes that lack an `embedding` field, rate-limited to ~1 req/sec.
 * Calls `onBatchSave` every 10 nodes so the graph is persisted incrementally.
 */
export async function batchEmbedWithRateLimit(
  nodes: KnowledgeNode[],
  onBatchSave: () => void,
  delayMs = EMBED_DELAY_MS,
): Promise<void> {
  const unembedded = nodes.filter((n) => !n.embedding);
  if (unembedded.length === 0) return;

  console.log(`[embeddings] Backfilling ${unembedded.length} nodes without embeddings...`);
  let processed = 0;
  const BATCH_SIZE = 10;

  for (let i = 0; i < unembedded.length; i++) {
    const node = unembedded[i];
    const embedding = await generateEmbedding(embedText(node));
    if (embedding) node.embedding = embedding;
    processed++;

    if (processed % BATCH_SIZE === 0) {
      onBatchSave();
      console.log(`[embeddings] Backfill progress: ${processed}/${unembedded.length}`);
    }

    // Rate-limit between requests, but not after the last one
    if (i < unembedded.length - 1) {
      await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
    }
  }

  if (processed % BATCH_SIZE !== 0) onBatchSave();
  console.log(`[embeddings] Backfill complete (${processed} nodes processed)`);
}
