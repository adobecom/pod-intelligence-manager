import { randomUUID } from "crypto";
import db from "../../db/connection.js";
import { getRelevantLearnings } from "../../services/knowledge-graph.js";
import { generateEmbedding, cosineSimilarity, isEmbeddingAvailable } from "../../services/embeddings.js";

interface PodRow {
  pod_id: string;
  name: string;
  org_id: string | null;
}

const STOP_WORDS = new Set([
  "the", "a", "an", "is", "are", "was", "were", "be", "been", "being",
  "have", "has", "had", "do", "does", "did", "will", "would", "could",
  "should", "may", "might", "shall", "can", "need", "to", "of", "in",
  "for", "on", "with", "at", "by", "from", "as", "into", "through",
  "and", "but", "or", "nor", "not", "no", "so", "than", "too",
  "very", "just", "about", "up", "this", "that", "these", "those",
  "it", "its", "we", "they", "them", "their", "our", "my", "your",
  "now", "new", "also", "added", "updated", "implemented",
]);

function extractKeywords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP_WORDS.has(w));
}

/**
 * Similarity threshold above which two pods are considered to overlap.
 * Tuned loosely — cosine 0.75 on Titan embeddings generally means "same topic, different phrasing".
 * Lower = more false positives, higher = misses semantic overlap.
 */
const SIMILARITY_THRESHOLD = 0.75;
/** Keyword-overlap fallback threshold (count of shared non-stop-word tokens). */
const KEYWORD_FALLBACK_THRESHOLD = 5;
/** Chars of context per pod to feed the embedder — avoids Titan input-size hits on chatty pods. */
const POD_CONTEXT_MAX_CHARS = 1500;

function buildPodContext(podId: string): { text: string; keywords: Set<string>; topTerms: string[] } {
  const updates = db.prepare(
    "SELECT summary FROM context_updates WHERE pod_id = ? ORDER BY timestamp DESC LIMIT 20",
  ).all(podId) as { summary: string }[];

  const keywords = new Set<string>();
  for (const u of updates) {
    for (const kw of extractKeywords(u.summary)) {
      keywords.add(kw);
    }
  }

  const text = updates.map((u) => u.summary).join(" \n").slice(0, POD_CONTEXT_MAX_CHARS);
  // Surface a few representative terms for the overlap description, regardless of
  // whether similarity was computed via embeddings or keyword overlap.
  const topTerms = [...keywords].slice(0, 5);
  return { text, keywords, topTerms };
}

export async function detectOverlaps(): Promise<void> {
  const pods = db.prepare(
    "SELECT pod_id, name, org_id FROM pods WHERE pod_id IN (SELECT pod_id FROM org_pod_summaries)",
  ).all() as unknown as unknown as PodRow[];

  if (pods.length < 2) return;

  const contexts = new Map<string, { text: string; keywords: Set<string>; topTerms: string[]; embedding: number[] | null }>();
  const useEmbeddings = isEmbeddingAvailable();

  for (const pod of pods) {
    const ctx = buildPodContext(pod.pod_id);
    let embedding: number[] | null = null;
    if (useEmbeddings && ctx.text.trim()) {
      try {
        embedding = await generateEmbedding(ctx.text);
      } catch {
        // If one pod fails we keep keyword fallback for that pod only; no need to abort.
        embedding = null;
      }
    }
    contexts.set(pod.pod_id, { ...ctx, embedding });
  }

  db.prepare("DELETE FROM cross_pod_overlaps").run();

  const insert = db.prepare(
    `INSERT INTO cross_pod_overlaps (id, pod_a, pod_b, description, advisory, org_id)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );

  for (let i = 0; i < pods.length; i++) {
    for (let j = i + 1; j < pods.length; j++) {
      const podA = pods[i];
      const podB = pods[j];
      if (!podA.org_id || podA.org_id !== podB.org_id) continue;

      const ctxA = contexts.get(podA.pod_id)!;
      const ctxB = contexts.get(podB.pod_id)!;

      let overlap = false;
      let reason = "";

      if (ctxA.embedding && ctxB.embedding) {
        const sim = cosineSimilarity(ctxA.embedding, ctxB.embedding);
        if (sim >= SIMILARITY_THRESHOLD) {
          overlap = true;
          reason = `semantic similarity ${sim.toFixed(2)}`;
        }
      } else {
        // Embedding unavailable for at least one pod — fall back to keyword overlap.
        const shared = [...ctxA.keywords].filter((kw) => ctxB.keywords.has(kw));
        if (shared.length >= KEYWORD_FALLBACK_THRESHOLD) {
          overlap = true;
          reason = `shared terms: ${shared.slice(0, 5).join(", ")}`;
        }
      }

      if (!overlap) continue;

      // Surface representative terms from whichever pod has more context; agents need
      // *something* concrete in the description even when the match is semantic.
      const description = ctxA.topTerms.length >= ctxB.topTerms.length
        ? `Related work (${reason}): ${ctxA.topTerms.join(", ")}`
        : `Related work (${reason}): ${ctxB.topTerms.join(", ")}`;

      let advisory = `${podA.name} and ${podB.name} appear to be tackling related concepts. Coordinate to avoid conflicting approaches.`;
      try {
        const seedDomains = [...new Set([...ctxA.topTerms, ...ctxB.topTerms])].slice(0, 3);
        if (seedDomains.length > 0 && podA.org_id) {
          const historicalLearnings = await getRelevantLearnings(podA.org_id, seedDomains, [], 500);
          if (historicalLearnings.nodes.length > 0) {
            const relevantNote = historicalLearnings.nodes[0];
            advisory += ` Historical note: "${relevantNote.summary}" (from ${relevantNote.source_pod_name}).`;
          }
        }
      } catch {
        // Knowledge graph may not be initialized — skip silently
      }

      insert.run(
        `overlap-${randomUUID().slice(0, 8)}`,
        podA.name,
        podB.name,
        description,
        advisory,
        podA.org_id,
      );
    }
  }
}
