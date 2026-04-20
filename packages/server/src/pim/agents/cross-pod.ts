import { randomUUID } from "crypto";
import db from "../../db/connection.js";
import { getRelevantLearnings } from "../../services/knowledge-graph.js";

interface UpdateRow {
  pod_id: string;
  scope: string;
  summary: string;
}

interface PodRow {
  pod_id: string;
  name: string;
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

export async function detectOverlaps(): Promise<void> {
  // Get all active pods
  const pods = db.prepare(
    "SELECT pod_id, name FROM pods WHERE pod_id IN (SELECT pod_id FROM org_pod_summaries)",
  ).all() as PodRow[];

  if (pods.length < 2) return;

  // Collect keywords per pod from recent updates
  const podKeywords = new Map<string, Set<string>>();
  for (const pod of pods) {
    const updates = db.prepare(
      "SELECT summary FROM context_updates WHERE pod_id = ? ORDER BY timestamp DESC LIMIT 20",
    ).all(pod.pod_id) as { summary: string }[];

    const keywords = new Set<string>();
    for (const u of updates) {
      for (const kw of extractKeywords(u.summary)) {
        keywords.add(kw);
      }
    }
    podKeywords.set(pod.pod_id, keywords);
  }

  // Clear existing overlaps and recompute
  db.prepare("DELETE FROM cross_pod_overlaps").run();

  const insert = db.prepare(
    `INSERT INTO cross_pod_overlaps (id, pod_a, pod_b, description, advisory)
     VALUES (?, ?, ?, ?, ?)`,
  );

  // Compare each pair of pods
  for (let i = 0; i < pods.length; i++) {
    for (let j = i + 1; j < pods.length; j++) {
      const podA = pods[i];
      const podB = pods[j];
      const kwA = podKeywords.get(podA.pod_id)!;
      const kwB = podKeywords.get(podB.pod_id)!;

      const shared = [...kwA].filter((kw) => kwB.has(kw));
      if (shared.length >= 5) {
        const topTerms = shared.slice(0, 5).join(", ");

        // Enrich with historical knowledge
        let advisory = `Both pods are working on related concepts (${topTerms}). Coordinate to avoid conflicting approaches.`;
        try {
          const historicalLearnings = await getRelevantLearnings(shared.slice(0, 3), [], 500);
          if (historicalLearnings.nodes.length > 0) {
            const relevantNote = historicalLearnings.nodes[0];
            advisory += ` Historical note: "${relevantNote.summary}" (from ${relevantNote.source_pod_name}).`;
          }
        } catch {
          // Knowledge graph may not be initialized — skip silently
        }

        insert.run(
          `overlap-${randomUUID().slice(0, 8)}`,
          podA.name,
          podB.name,
          `Shared context: ${topTerms}`,
          advisory,
        );
      }
    }
  }
}
