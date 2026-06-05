import type { PromptTier, Task } from "./types.js";

/**
 * Prompt realism tier assignments (finding #8), kept here as a single
 * two-person-reviewable map mirroring `stratification.ts`. The headline
 * PIM-vs-baseline-vs-LIC claim is computed on `realistic-ticket` only; the other
 * tiers are reported separately (saturated = sanity check, underspecified =
 * context-discovery probe, context-required = mechanism test for PIM).
 *
 * Source-excerpt prompts are deliberately kept out of `realistic-ticket` unless
 * they are rewritten or explicitly justified as a baseline starting-file excerpt.
 */
const PROMPT_TIERS: Record<string, PromptTier> = {
  // ── real-emc headline: rewritten saturated → realistic-ticket ──────────────
  "real-emc-datatable-horizontal-edge-scroll": "realistic-ticket",
  "real-emc-event-form-route-with-event-id": "realistic-ticket",
  "real-emc-event-mod-time-sync-after-session": "realistic-ticket",
  "real-emc-event-put-omit-detail-page-path": "realistic-ticket",
  "real-emc-partner-put-sponsor-id-payload": "realistic-ticket",
  "real-emc-ppn-ack-hydration": "realistic-ticket",
  "real-emc-ppn-explicit-select": "realistic-ticket",
  "real-emc-rbac-events-dashboard-gating": "realistic-ticket",
  "real-emc-rte-quill-semantic-html": "realistic-ticket",
  "real-emc-s2-tabs-crash-segmented-control": "realistic-ticket",
  "real-emc-scope-group-my-filter": "realistic-ticket",
  "real-emc-series-form-footer-alignment": "realistic-ticket",
  "real-emc-session-api-batch-optimisation": "realistic-ticket",
  "real-emc-session-api-error-toast": "realistic-ticket",
  "real-emc-speaker-image-cache-invalidate": "realistic-ticket",
  "real-emc-speaker-type-mapping-hotfix": "realistic-ticket",

  // ── real-emc headline: kept as-is (already ticket-shaped) ──────────────────
  // These still include pasted parent-source excerpts. They remain useful
  // sanity checks, but they do not carry the realistic-ticket headline until
  // rewritten or explicitly justified as a baseline starting-file excerpt.
  "real-emc-detail-page-path-put": "saturated",
  "real-emc-include-partners-toggle": "saturated",
  "real-emc-prod-publish-confirmation": "saturated",
  "real-emc-series-put-readonly-targetcms": "saturated",
  "real-emc-session-location-time-overlap": "saturated",
  "real-emc-sxsw-ticket-field-config-service": "saturated",

  // ── real-emc headline: genuinely vague ────────────────────────────────────
  "real-emc-session-time-no-refresh": "underspecified",

  // ── synthetic context-stress tasks ────────────────────────────────────────
  "synth-event-speaker-put-contract-context": "context-required",
  "synth-session-time-response-state": "context-required",
  "synth-registration-locale-overlay": "context-required",
  "synth-event-route-after-create": "context-required",
  "synth-session-speaker-sync-plan": "context-required",
  "synth-series-put-update-plan": "context-required",
  "synth-event-sort-negative-control": "saturated",
};

/**
 * Resolve a task's prompt tier: explicit `task.promptTier` wins, then the map,
 * then a tag heuristic, defaulting to `realistic-ticket`.
 */
export function classifyPromptTier(task: Task): PromptTier {
  if (task.promptTier) return task.promptTier;
  const mapped = PROMPT_TIERS[task.id];
  if (mapped) return mapped;
  const tags = task.tags ?? [];
  if (tags.includes("saturated") || tags.includes("fully-specified") || tags.includes("negative-control")) return "saturated";
  if (tags.includes("context-stress") || tags.includes("pim-needed") || tags.includes("lic-needed") || tags.includes("combined-needed")) {
    return "context-required";
  }
  if (tags.includes("vague-issue")) return "underspecified";
  return "realistic-ticket";
}

export const PROMPT_TIER_ORDER: PromptTier[] = ["realistic-ticket", "context-required", "underspecified", "saturated"];
