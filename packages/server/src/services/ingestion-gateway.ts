/**
 * Unified Ingestion Gateway — the single entry point for all knowledge graph
 * ingestion paths.
 *
 * Every inlet (pod archival, ad-hoc API/SDK/MCP, scheduled synthesis,
 * project-memory, seeding) calls `ingestLearnings` instead of calling
 * `addLearningsToGraph` directly. This guarantees that all knowledge — regardless
 * of how it arrives — passes the same quality gate before being embedded, deduped,
 * and relationally wired into the graph by the core `addLearningsToGraph`.
 *
 * Gate stages (all synchronous + deterministic, no LLM cost added):
 *   1. Sanitize — safety (HTML/control-char/bidi/injection) + quality (whitespace).
 *   2. Normalize domains — lowercase + trim + dedupe; map to existing taxonomy.
 *   3. Clamp confidence — ad-hoc submissions capped at AD_HOC_CONFIDENCE_CEILING.
 *   4. Drop learnings that fail min thresholds after the above transforms.
 *
 * Embedding, dedup, relational edge-building, and persistence all happen downstream
 * in `addLearningsToGraph` (knowledge-graph.ts) — unchanged.
 */

import type { EnhancedPodLearning } from "@pim/shared";
import { getGraph, addLearningsToGraph } from "./knowledge-graph.js";
import type { AddLearningsOptions } from "./knowledge-graph.js";

export type IngestionSource =
  | "pod_archival"
  | "ad_hoc"
  | "synthesis"
  | "project_memory"
  | "agent_run"
  | "seed";

// Ad-hoc (uncurated external) submissions are capped here so they cannot
// claim high confidence until a human curates the node.
const AD_HOC_CONFIDENCE_CEILING = 0.7;

// Length limits aligned with the existing AdHocLearningSchema (Zod, graph.ts:64-71)
// so every inlet enforces the same bounds.
const SUMMARY_MIN = 10;
const SUMMARY_MAX = 500;
const DETAILS_MIN = 30;
const DETAILS_MAX = 4000;

// ---------------------------------------------------------------------------
// Pure helpers — exported for unit testing.
// ---------------------------------------------------------------------------

/**
 * Sanitizes a text field: safety + quality pass.
 *
 * Safety:
 *   - Strip zero-width, bidi-override, and invisible Unicode chars.
 *   - Strip C0/C1 control chars (preserves \n and \t).
 *   - Remove <script>…</script> and <style>…</style> blocks.
 *   - Strip remaining HTML tags.
 *   - Conservative prompt-injection scrub on directive-only lines.
 *     Intentionally light to avoid corrupting legitimate technical prose.
 *
 * Quality:
 *   - Collapse runs of non-newline whitespace to a single space.
 *   - Collapse 3+ consecutive blank lines to 2.
 *   - Trim leading/trailing whitespace.
 */
export function sanitizeText(s: string): string {
  if (typeof s !== "string") return "";

  let out = s;

  // 1. Strip zero-width (U+200B–U+200D, U+FEFF) and bidi-override
  //    (U+202A–U+202E, U+2066–U+2069) chars. Explicit \u escapes — no literal
  //    invisible Unicode in source so the intent stays auditable.
  out = out.replace(/[\u200B-\u200D\uFEFF\u202A-\u202E\u2066-\u2069]/gu, "");

  // 2. Strip C0/C1 control chars, preserving \t (0x09) and \n (0x0A).
  // eslint-disable-next-line no-control-regex
  out = out.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/gu, "");

  // 3. Remove <script>…</script> and <style>…</style> blocks.
  out = out.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "");
  out = out.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "");

  // 4. Strip remaining HTML tags.
  out = out.replace(/<\/?[a-zA-Z][^>]*>/g, "");

  // 5. Strip triple-backtick code-fence delimiter lines (preserves content).
  out = out.replace(/^```[^\n]*$/gm, "");

  // 6. Drop standalone prompt-injection directive lines (conservative allowlist).
  //    Matches lines like "Ignore all previous instructions." — not mid-sentence.
  out = out.replace(
    /^\s*(ignore|disregard)\s+(all\s+)?(previous|prior|above)\s+instructions?\s*\.?\s*$/gim,
    "",
  );

  // 7. Collapse 3+ consecutive newlines to 2.
  out = out.replace(/\n{3,}/g, "\n\n");

  // 8. Collapse runs of non-newline, non-tab whitespace to a single space.
  //    Tabs are preserved — they may appear in code snippets embedded in details.
  out = out.replace(/[^\S\n\t]+/g, " ");

  // 9. Trim.
  return out.trim();
}

/**
 * Normalize a list of domain strings to their canonical lowercased-trimmed form.
 * Deduplicates and filters empty strings.
 *
 * `known` is a Set of already-canonical (lowercased) domain strings from the
 * existing org graph, used to detect reuse vs. taxonomy fragmentation.
 * Currently, domains that don't exist in `known` are still accepted — new
 * knowledge can introduce new domains. The primary normalization is case + whitespace.
 */
export function normalizeDomains(domains: string[], known: Set<string>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const d of domains) {
    const norm = d.toLowerCase().trim();
    if (!norm || seen.has(norm)) continue;
    seen.add(norm);
    // Whether the domain is in `known` or not, we use the normalized form.
    // When it IS in `known`, lowercasing ensures it collapses to the canonical value.
    out.push(norm);
  }
  return out;
}

/**
 * Clamp a confidence score to [0, 1].
 * Ad-hoc submissions are additionally capped at AD_HOC_CONFIDENCE_CEILING (0.7)
 * so uncurated external seeds cannot claim high confidence until human-curated.
 *
 * NaN input defaults to 0 (non-ad_hoc) or the ceiling (ad_hoc) rather than
 * propagating NaN into the graph. ±Infinity is handled by the Math.max/min clamp
 * naturally (+Infinity → 1, -Infinity → 0).
 */
export function clampConfidence(score: number, source: IngestionSource): number {
  if (Number.isNaN(score)) {
    return source === "ad_hoc" ? AD_HOC_CONFIDENCE_CEILING : 0;
  }
  const clamped = Math.max(0, Math.min(1, score));
  return source === "ad_hoc" ? Math.min(clamped, AD_HOC_CONFIDENCE_CEILING) : clamped;
}

// ---------------------------------------------------------------------------
// Preparation stage — pure, no I/O.
// ---------------------------------------------------------------------------

export interface PreparedLearnings {
  prepared: EnhancedPodLearning[];
  droppedCount: number;
}

/**
 * Apply the full quality gate to an array of learnings:
 *   1. Sanitize summary + details.
 *   2. Normalize domains.
 *   3. Clamp confidence scores.
 *   4. Drop learnings that fail min-length thresholds or produce empty domain lists.
 *
 * `knownDomains` defaults to the lowercased domain set derived from the current
 * org graph (lazy-fetched). Pass an explicit value in tests or when you already
 * have the graph in scope.
 */
export function prepareLearnings(
  orgId: string,
  learnings: EnhancedPodLearning[],
  source: IngestionSource,
  knownDomains?: Set<string>,
): PreparedLearnings {
  // Build canonical domain set from the live graph if not supplied.
  let known: Set<string>;
  if (knownDomains !== undefined) {
    known = knownDomains;
  } else {
    try {
      const nodes = getGraph(orgId).nodes;
      known = new Set(nodes.flatMap((n) => n.domains).map((d) => d.toLowerCase().trim()).filter(Boolean));
    } catch {
      // Graph not initialised yet (e.g. first seed run on a fresh org) — fine.
      known = new Set();
    }
  }

  const prepared: EnhancedPodLearning[] = [];
  let droppedCount = 0;

  for (const learning of learnings) {
    const summary = sanitizeText(learning.summary);
    const details = sanitizeText(learning.details);

    // Quality bounds — same thresholds as AdHocLearningSchema so all inlets agree.
    if (summary.length < SUMMARY_MIN || summary.length > SUMMARY_MAX) {
      droppedCount++;
      continue;
    }
    if (details.length < DETAILS_MIN) {
      droppedCount++;
      continue;
    }

    const domains = normalizeDomains(learning.domains, known);
    if (domains.length === 0) {
      // A mis-tagged node is worse than a dropped one (poisons cross-domain queries).
      droppedCount++;
      continue;
    }

    prepared.push({
      ...learning,
      summary,
      // Spread to Unicode code points before slicing so a surrogate pair
      // straddling position DETAILS_MAX is never split (lone surrogates corrupt
      // embedding input and stored text).
      details: [...details].slice(0, DETAILS_MAX).join(""),
      domains,
      confidence_score: clampConfidence(learning.confidence_score, source),
    });
  }

  return { prepared, droppedCount };
}

// ---------------------------------------------------------------------------
// Public gateway.
// ---------------------------------------------------------------------------

/**
 * The single entry point for all knowledge graph ingestion.
 *
 * Runs the quality gate (prepareLearnings), then delegates to addLearningsToGraph
 * for embedding, dedup, relational edge-building, supersession, and persistence.
 * Returns the core result plus `droppedCount` (learnings rejected by the gate).
 */
export async function ingestLearnings(
  orgId: string,
  learnings: EnhancedPodLearning[],
  podId: string,
  podName: string,
  source: IngestionSource,
  project?: { project_id: string; project_name: string },
  options?: AddLearningsOptions,
): Promise<{ nodesAdded: number; edgesAdded: number; nodeIds: string[]; droppedCount: number }> {
  const { prepared, droppedCount } = prepareLearnings(orgId, learnings, source);

  if (droppedCount > 0) {
    console.log(
      `[ingestion-gateway] Dropped ${droppedCount} learning(s) in pre-processing (source="${source}", org="${orgId}")`,
    );
  }

  if (prepared.length === 0) {
    return { nodesAdded: 0, edgesAdded: 0, nodeIds: [], droppedCount };
  }

  const result = await addLearningsToGraph(orgId, prepared, podId, podName, project, options);
  return { ...result, droppedCount };
}
