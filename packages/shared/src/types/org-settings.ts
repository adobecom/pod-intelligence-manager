import type { KnowledgeNodeType } from "./graph.js";

/** Single workstream / context-update scope (id is stable; label is UI). Also used for project anatomy internal slots. */
export interface OrgScopeDefinition {
  id: string;
  label: string;
}

/** Persisted org-level configuration (single-tenant: one row per deployment). */
export interface OrgConfig {
  scopes: OrgScopeDefinition[];
}

const LEGACY_SCOPES: OrgScopeDefinition[] = [
  { id: "frontend", label: "Frontend" },
  { id: "backend", label: "Backend" },
  { id: "design", label: "Design" },
  { id: "qa", label: "QA" },
  { id: "infra", label: "Infra" },
  { id: "pm", label: "PM" },
];

/** Default six scopes (legacy behavior). */
export const DEFAULT_ORG_CONFIG: OrgConfig = {
  scopes: LEGACY_SCOPES.map(s => ({ ...s })),
};

/**
 * Per-org behavioral tuning. All values start at DEFAULT_ORG_TUNING and are
 * nudged autonomously by the tuning agent after each pod archival — never
 * edited manually. Surface as read-only in the UI.
 */
export interface OrgTuning {
  pressure: {
    normalMax: number;       // default 0.3
    cautiousMax: number;     // default 0.6
    degradedMax: number;     // default 0.8
  };
  pressureWeights: {
    blockingBase: number;    // default 0.15
    nonBlockingBase: number; // default 0.08
    ageFactorCap: number;    // default 0.1
    ageWindowHours: number;  // default 48
    dependencyBonus: number; // default 0.05
  };
  kgPatternScout: {
    enabled: boolean;
    maxTokens: number;
    minQuerySimilarity: number;
    advisoryMinConf: number;
    openConflictMinConf: number;
    types: KnowledgeNodeType[];
  };
  conflictLic: {
    additiveMinConf: number;      // default 0.65
    overlapForceMinConf: number;  // default 0.65
    suppressMergeMinConf: number; // default 0.65
    peerWindow: number;           // default 15
    detailsCap: number;           // default 900
  };
  graphScoring: {
    recencyDecayDays: number;       // default 90
    samePodDedupThreshold: number;  // default 0.85
    crossPodDedupThreshold: number; // default 0.95
    minQuerySimilarity: number;     // default 0.75
  };
  lint: {
    stalenessHours: number;        // default 8
    maxLlmFindings: number;        // default 8
    livingDocMaxChars: number;     // default 10_000
    updateDetailsMaxChars: number; // default 800
  };
  classifier: {
    peerWindow: number;           // default 5
    overlapKeywordMin: number;    // default 3
    highPressureOverride: number; // default 0.6
  };
}

export const DEFAULT_ORG_TUNING: OrgTuning = {
  pressure:        { normalMax: 0.3, cautiousMax: 0.6, degradedMax: 0.8 },
  pressureWeights: { blockingBase: 0.15, nonBlockingBase: 0.08, ageFactorCap: 0.1, ageWindowHours: 48, dependencyBonus: 0.05 },
  kgPatternScout: {
    enabled: true,
    maxTokens: 1500,
    minQuerySimilarity: 0.75,
    advisoryMinConf: 0.55,
    openConflictMinConf: 0.72,
    types: ["decision", "pattern", "anti_pattern", "resolved_conflict"],
  },
  conflictScout:   { additiveMinConf: 0.65, overlapForceMinConf: 0.65, suppressMergeMinConf: 0.65, peerWindow: 15, detailsCap: 900 },
  graphScoring:    { recencyDecayDays: 90, samePodDedupThreshold: 0.85, crossPodDedupThreshold: 0.95, minQuerySimilarity: 0.75 },
  lint:            { stalenessHours: 8, maxLlmFindings: 8, livingDocMaxChars: 10_000, updateDetailsMaxChars: 800 },
  classifier:      { peerWindow: 5, overlapKeywordMin: 3, highPressureOverride: 0.6 },
};
