import type { EvalRow } from "../report.js";
import { compareAllPairs, comparePair, severeRegressionRate, verdictFor, type PairwiseComparison, type Verdict } from "./pairwise.js";
import type { LicFixtureSignal } from "./lic-quality.js";
import { PROMPT_TIER_ORDER } from "../tasks/prompt-tiers.js";

export const PRIMARY_PROTOCOL_ARMS = [
  "pim-full",
  "kg-only",
  "lic-full",
  "lic-pim-combined",
] as const;

export const SECONDARY_PROTOCOL_ARMS = ["control"] as const;
export const DEFAULT_PROTOCOL_ARMS = [...SECONDARY_PROTOCOL_ARMS, ...PRIMARY_PROTOCOL_ARMS] as const;
export const HEADLINE_STRATA = ["S1", "S2", "S3", "S4", "S5"] as const;

export interface ArmSummary {
  arm: string;
  pass: number;
  total: number;
  passRate: number;
  avgScore: number;
}

export interface ProtocolComparison extends PairwiseComparison {
  severeRegressionRate: number;
  verdict: Verdict;
}

export interface FocusVerdict {
  armA: string;
  armB: string;
  label: string;
  comparison?: ProtocolComparison;
}

export interface StratumAnalysis {
  stratum: string;
  rowCount: number;
  taskCount: number;
  armSummaries: ArmSummary[];
}

export interface PromptTierAnalysis {
  tier: string;
  rowCount: number;
  taskCount: number;
  armSummaries: ArmSummary[];
}

export interface SensitivityAnalysis {
  id: string;
  label: string;
  rowCount: number;
  taskCount: number;
  armSummaries: ArmSummary[];
  comparisons: ProtocolComparison[];
}

export interface ProtocolAnalysis {
  generatedAt: string;
  primaryArms: string[];
  headlineRowCount: number;
  headlineTaskCount: number;
  secondaryRowCount: number;
  secondaryTaskCount: number;
  secondaryArmSummaries: ArmSummary[];
  armSummaries: ArmSummary[];
  /** Pass-rate summary for every arm present in the headline rows (incl. control, clipped). */
  allArmSummaries: ArmSummary[];
  comparisons: ProtocolComparison[];
  focusVerdicts: FocusVerdict[];
  /** Headline focus restricted to realistic-ticket tasks — the primary claim set. */
  realisticTicketFocus: FocusVerdict[];
  realisticTicketTaskCount: number;
  perStratum: StratumAnalysis[];
  /** Pass rates per arm, sliced by prompt realism tier (headline rows). */
  perPromptTier: PromptTierAnalysis[];
  licQualityDistribution: Record<LicFixtureSignal | "unknown", number>;
  licQualitySensitivity: SensitivityAnalysis[];
}

export function computeProtocolAnalysis(
  rows: EvalRow[],
  opts: { bootstrapIterations?: number; generatedAt?: string; primaryArms?: readonly string[] } = {},
): ProtocolAnalysis {
  const primaryArms = [...(opts.primaryArms ?? PRIMARY_PROTOCOL_ARMS)];
  const headline = headlineRows(rows);
  const secondary = rows.filter((r) => r.stratum === "S6");
  const comparisons = protocolComparisons(headline, primaryArms, opts.bootstrapIterations);
  // Headline claim set: realistic-ticket only (saturated/underspecified/context-
  // required reported separately so they don't carry the claim).
  const realistic = realisticTicketHeadlineRows(rows);
  const realisticComparisons = protocolComparisons(realistic, primaryArms, opts.bootstrapIterations);
  return {
    generatedAt: opts.generatedAt ?? new Date().toISOString(),
    primaryArms,
    headlineRowCount: headline.length,
    headlineTaskCount: distinct(headline.map((r) => r.taskId)).length,
    secondaryRowCount: secondary.length,
    secondaryTaskCount: distinct(secondary.map((r) => r.taskId)).length,
    secondaryArmSummaries: summarizeArms(secondary, primaryArms),
    armSummaries: summarizeArms(headline, primaryArms),
    allArmSummaries: summarizeArms(headline, distinct(headline.map((r) => r.arm))),
    comparisons,
    focusVerdicts: focusVerdicts(comparisons, headline),
    realisticTicketFocus: focusVerdicts(realisticComparisons, realistic),
    realisticTicketTaskCount: distinct(realistic.map((r) => r.taskId)).length,
    perStratum: perStratum(headline, primaryArms),
    perPromptTier: perPromptTier(headline, primaryArms),
    licQualityDistribution: licQualityDistribution(headline),
    licQualitySensitivity: sensitivitySlices(realistic, primaryArms, opts.bootstrapIterations),
  };
}

export function headlineRows(rows: EvalRow[]): EvalRow[] {
  return rows.filter((r) => HEADLINE_STRATA.includes(r.stratum as (typeof HEADLINE_STRATA)[number]));
}

export function realisticTicketHeadlineRows(rows: EvalRow[]): EvalRow[] {
  return headlineRows(rows).filter((r) => r.promptTier === "realistic-ticket");
}

export function summarizeArms(rows: EvalRow[], armIds: readonly string[]): ArmSummary[] {
  return armIds.map((arm) => {
    const armRows = rows.filter((r) => r.arm === arm);
    const pass = armRows.filter((r) => r.judge.passed).length;
    return {
      arm,
      pass,
      total: armRows.length,
      passRate: armRows.length === 0 ? 0 : pass / armRows.length,
      avgScore: mean(armRows.map((r) => r.judge.score)),
    };
  });
}

function protocolComparisons(rows: EvalRow[], armIds: readonly string[], bootstrapIterations = 10_000): ProtocolComparison[] {
  return compareAllPairs(rows, [...armIds], bootstrapIterations).map((comparison) => {
    const srr = severeRegressionRate(rows, comparison.armA, comparison.armB);
    return {
      ...comparison,
      severeRegressionRate: srr,
      verdict: verdictFor(comparison, srr),
    };
  });
}

// Oriented so a positive delta favours armA. Baseline pairs come first:
// control is the operational baseline. The matched-budget pairs (vs *-clipped)
// only resolve when those arms were run.
const FOCUS_PAIRS: Array<[string, string, string]> = [
  ["pim-full", "control", "PIM vs control (operational baseline)"],
  ["pim-full", "lic-full", "PIM full bundle vs locally indexed code"],
  ["kg-only", "lic-full", "KG only vs locally indexed code"],
  ["pim-full", "kg-only", "Full PIM bundle vs KG only"],
  ["lic-pim-combined", "pim-full", "Budget-split combined vs PIM only"],
  ["lic-pim-combined", "lic-full", "Budget-split combined vs locally indexed code only"],
  ["lic-pim-combined", "pim-clipped", "Combined vs PIM (matched budget)"],
  ["lic-pim-combined", "lic-clipped", "Combined vs locally indexed code (matched budget)"],
  // Serena focus pairs — resolve standalone only when the serena arms were run
  // (focusComparison returns undefined otherwise), so they are inert for non-serena runs.
  ["serena-full", "control", "Serena vs control (standalone code-intelligence lift)"],
  ["serena-full", "lic-full", "Serena vs locally indexed code (LIC provider comparison)"],
  ["serena-pim-combined", "pim-full", "Serena+PIM combined vs PIM only"],
  ["serena-pim-combined", "serena-full", "Serena+PIM combined vs Serena only"],
  ["serena-pim-combined", "lic-pim-combined", "Serena+PIM vs LIC+PIM (combined providers)"],
  ["serena-pim-combined", "pim-clipped", "Serena+PIM vs PIM (matched budget)"],
  ["serena-pim-combined", "serena-clipped", "Serena+PIM vs Serena (matched budget)"],
];

function focusVerdicts(comparisons: ProtocolComparison[], rows: EvalRow[]): FocusVerdict[] {
  return FOCUS_PAIRS.map(([armA, armB, label]) => ({
    armA,
    armB,
    label,
    comparison: focusComparison(comparisons, rows, armA, armB),
  }));
}

/**
 * Resolve a focus comparison oriented so a positive delta favours armA. Prefer the
 * BH-adjusted precomputed comparison from the primary family; otherwise compute a
 * standalone comparison directly from the rows (e.g. for `control` or the
 * matched-budget clipped arms, which are not in the primary family). Returns
 * undefined when either arm has no rows.
 */
function focusComparison(comparisons: ProtocolComparison[], rows: EvalRow[], armA: string, armB: string): ProtocolComparison | undefined {
  const oriented = orientComparison(comparisons, rows, armA, armB);
  if (oriented) return oriented;
  const hasA = rows.some((r) => r.arm === armA);
  const hasB = rows.some((r) => r.arm === armB);
  if (!hasA || !hasB) return undefined;
  const base = comparePair(rows, armA, armB);
  const srr = severeRegressionRate(rows, armA, armB);
  return { ...base, severeRegressionRate: srr, verdict: verdictFor(base, srr) };
}

function orientComparison(comparisons: ProtocolComparison[], rows: EvalRow[], armA: string, armB: string): ProtocolComparison | undefined {
  const direct = comparisons.find((c) => c.armA === armA && c.armB === armB);
  if (direct) return direct;
  const reverse = comparisons.find((c) => c.armA === armB && c.armB === armA);
  if (!reverse) return undefined;
  const oriented: ProtocolComparison = {
    ...reverse,
    armA,
    armB,
    meanDeltaPp: -reverse.meanDeltaPp,
    ciLowPp: -reverse.ciHighPp,
    ciHighPp: -reverse.ciLowPp,
    cohensD: -reverse.cohensD,
    pairedTaskIds: reverse.pairedTaskIds,
    severeRegressionRate: severeRegressionRate(rows, armA, armB),
  };
  return {
    ...oriented,
    verdict: verdictFor(oriented, oriented.severeRegressionRate),
  };
}

function perStratum(rows: EvalRow[], armIds: readonly string[]): StratumAnalysis[] {
  return HEADLINE_STRATA.map((stratum) => {
    const subset = rows.filter((r) => r.stratum === stratum);
    return {
      stratum,
      rowCount: subset.length,
      taskCount: distinct(subset.map((r) => r.taskId)).length,
      armSummaries: summarizeArms(subset, armIds),
    };
  }).filter((entry) => entry.rowCount > 0);
}

function perPromptTier(rows: EvalRow[], armIds: readonly string[]): PromptTierAnalysis[] {
  return PROMPT_TIER_ORDER.map((tier) => {
    const subset = rows.filter((r) => r.promptTier === tier);
    return {
      tier,
      rowCount: subset.length,
      taskCount: distinct(subset.map((r) => r.taskId)).length,
      armSummaries: summarizeArms(subset, armIds),
    };
  }).filter((entry) => entry.rowCount > 0);
}

function licQualityDistribution(rows: EvalRow[]): Record<LicFixtureSignal | "unknown", number> {
  const perTask = new Map<string, LicFixtureSignal | "unknown">();
  for (const row of rows) {
    if (!perTask.has(row.taskId)) perTask.set(row.taskId, row.licFixtureQuality?.signal ?? "unknown");
  }
  const out: Record<LicFixtureSignal | "unknown", number> = {
    none: 0,
    weak: 0,
    medium: 0,
    strong: 0,
    leak: 0,
    unknown: 0,
  };
  for (const signal of perTask.values()) out[signal] += 1;
  return out;
}

function sensitivitySlices(rows: EvalRow[], armIds: readonly string[], bootstrapIterations = 10_000): SensitivityAnalysis[] {
  const slices: Array<{ id: string; label: string; rows: EvalRow[] }> = [
    { id: "all-headline", label: "All headline tasks", rows },
    {
      id: "exclude-none",
      label: "Excluding lic fixtures with signal=none",
      rows: rows.filter((r) => r.licFixtureQuality?.signal !== "none"),
    },
    {
      id: "exclude-leak",
      label: "Excluding lic fixtures with signal=leak",
      rows: rows.filter((r) => r.licFixtureQuality?.signal !== "leak"),
    },
    {
      id: "high-signal",
      label: "High-signal lic fixtures only (medium/strong)",
      rows: rows.filter((r) => r.licFixtureQuality?.signal === "medium" || r.licFixtureQuality?.signal === "strong"),
    },
  ];

  return slices.map((slice) => ({
    id: slice.id,
    label: slice.label,
    rowCount: slice.rows.length,
    taskCount: distinct(slice.rows.map((r) => r.taskId)).length,
    armSummaries: summarizeArms(slice.rows, armIds),
    comparisons: protocolComparisons(slice.rows, armIds, bootstrapIterations),
  }));
}

function distinct<T>(values: T[]): T[] {
  return Array.from(new Set(values));
}

function mean(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}
