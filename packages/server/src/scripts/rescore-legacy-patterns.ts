/**
 * Rescore legacy 0.9-confidence pattern nodes using the Haiku durability classifier.
 *
 * Background: before the durability-classifier work, every deterministic pattern node was
 * stamped with confidence_score=0.9 — including renames, typos, and other ephemeral edits.
 * The 180-day pruner only sweeps nodes scored < 0.5, so those legacy nodes never auto-prune.
 *
 * This script reclassifies suspect legacy nodes in place. It does NOT delete anything; nodes
 * whose new score drops below 0.5 will flow through `pruneStaleNodes` once they age past 180
 * days. Re-runnable and idempotent.
 *
 * Usage:
 *   pnpm --filter @pim/server rescore-legacy [--dry-run]
 *   ORG_ID=acme pnpm --filter @pim/server rescore-legacy --dry-run
 */
import {
  initializeKnowledgeGraph,
  getGraph,
} from "../services/knowledge-graph.js";
import { saveGraph, restoreGraphFromS3IfEmpty } from "../services/graph-storage.js";
import {
  classifyDecisionDurability,
  type PodLearning,
} from "../pim/agents/knowledge-extraction.js";
import { isLLMAvailable } from "../pim/llm.js";

const BATCH_SIZE = 20;
const LEGACY_SCORE_THRESHOLD = 0.85; // Catches the previous 0.9 default and "high" LLM (0.85).

interface ScoreChange {
  id: string;
  before: number;
  after: number;
}

function isLegacyCandidate(node: {
  type: string;
  confidence?: string;
  confidence_score: number;
  curated: boolean;
  superseded_by?: string;
}): boolean {
  return (
    node.type === "pattern" &&
    node.confidence === "extracted" &&
    node.confidence_score >= LEGACY_SCORE_THRESHOLD &&
    !node.curated &&
    !node.superseded_by
  );
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const orgId = process.env.ORG_ID ?? "default";

  console.log(`[rescore-legacy] org=${orgId} dryRun=${dryRun}`);

  if (!isLLMAvailable()) {
    console.error(
      "[rescore-legacy] AWS_BEARER_TOKEN_BEDROCK is not set — Haiku classifier unavailable. Aborting.",
    );
    process.exit(1);
  }

  await restoreGraphFromS3IfEmpty(orgId);
  initializeKnowledgeGraph(orgId);
  const graph = getGraph();

  const candidates = graph.nodes.filter(isLegacyCandidate);
  console.log(
    `[rescore-legacy] ${candidates.length} of ${graph.nodes.length} nodes match the legacy pattern criteria`,
  );
  if (candidates.length === 0) {
    console.log("[rescore-legacy] Nothing to do.");
    return;
  }

  const changes: ScoreChange[] = [];
  for (let i = 0; i < candidates.length; i += BATCH_SIZE) {
    const batch = candidates.slice(i, i + BATCH_SIZE);
    const items: PodLearning[] = batch.map((n) => ({
      type: "pattern",
      summary: n.summary,
      details: n.details,
      scope: n.domains[0],
    }));
    const scores = await classifyDecisionDurability(items);
    batch.forEach((node, idx) => {
      const newScore = scores.get(idx);
      if (newScore === undefined) return;
      if (Math.abs(newScore - node.confidence_score) < 1e-9) return;
      changes.push({ id: node.id, before: node.confidence_score, after: newScore });
      if (!dryRun) node.confidence_score = newScore;
    });
    console.log(
      `[rescore-legacy] Batch ${i / BATCH_SIZE + 1}/${Math.ceil(candidates.length / BATCH_SIZE)} processed`,
    );
  }

  // Distribution buckets aligned to DURABILITY_TO_SCORE.
  const buckets = { high: 0, medium: 0, low: 0, junk: 0, unchanged: 0 };
  for (const c of changes) {
    if (c.after >= 0.85) buckets.high++;
    else if (c.after >= 0.7) buckets.medium++;
    else if (c.after >= 0.5) buckets.low++;
    else buckets.junk++;
  }
  buckets.unchanged = candidates.length - changes.length;
  const willPrune = changes.filter((c) => c.after < 0.5).length;

  console.log(
    `[rescore-legacy] Distribution: high=${buckets.high} medium=${buckets.medium} low=${buckets.low} junk=${buckets.junk} unchanged=${buckets.unchanged}`,
  );
  console.log(
    `[rescore-legacy] ${willPrune} node(s) will be eligible for the 180-day stale-prune sweep.`,
  );

  if (dryRun) {
    console.log("[rescore-legacy] --dry-run: no changes persisted.");
    return;
  }

  if (changes.length === 0) {
    console.log("[rescore-legacy] No score changes — graph not re-saved.");
    return;
  }

  graph.version++;
  graph.updated_at = new Date().toISOString();
  saveGraph(orgId, graph);
  console.log(`[rescore-legacy] Persisted ${changes.length} score updates (graph v${graph.version}).`);
}

main().catch((err) => {
  console.error("[rescore-legacy] Failed:", err);
  process.exit(1);
});
