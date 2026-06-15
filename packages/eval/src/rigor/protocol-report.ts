import type {
  ArmSummary,
  FocusVerdict,
  ProtocolAnalysis,
  ProtocolComparison,
  PromptTierAnalysis,
  SensitivityAnalysis,
  StratumAnalysis,
} from "./protocol-analysis.js";
import type { Verdict } from "./pairwise.js";

const VERDICT_LABEL: Record<Verdict, string> = {
  "strong-support": "✅ strong support",
  directional: "↗︎ directional",
  "no-effect": "• no supported effect",
  harm: "⛔ harm",
};

function pp(x: number): string {
  return `${x >= 0 ? "+" : ""}${x.toFixed(1)}`;
}

function pctOf(s: ArmSummary): string {
  return `${(s.passRate * 100).toFixed(0)}% (${s.pass}/${s.total})`;
}

function qCol(c: ProtocolComparison): string {
  if (c.bhAdjusted !== undefined) return `${c.bhAdjusted.toFixed(3)}${c.rejected ? " *" : ""}`;
  return `p=${c.pTwoSided.toFixed(3)}`;
}

/**
 * Render the protocol claim analysis as markdown lines for `report.md`. This is
 * the section the review flagged as missing: the focus comparisons (with CI, dz,
 * BH q, severe-regression rate, verdict), per-stratum pass rates, and the locally-
 * indexed-code quality sensitivity — previously only in `analysis.json`.
 */
export function renderProtocolReport(a: ProtocolAnalysis): string[] {
  const lines: string[] = [];
  lines.push("## Protocol Claim Analysis");
  lines.push("");
  lines.push(
    `_Headline strata S1–S5: ${a.headlineTaskCount} tasks, ${a.headlineRowCount} rows ` +
      `(${a.realisticTicketTaskCount} realistic-ticket). ` +
      `Secondary (S6, exploratory only): ${a.secondaryTaskCount} tasks. ` +
      `Operational baseline: **control**. The length-matched placebo arm is available only for ad-hoc regression checks._`,
  );
  lines.push("");

  // Primary claim: realistic-ticket only.
  lines.push(
    ...renderFocusTable(
      "### Headline claim — realistic-ticket tasks only",
      "The primary PIM-vs-baseline-vs-LIC claim uses only realistic-ticket prompts (the sole arm difference is the context source). Oriented so a positive Δ favours the first arm.",
      a.realisticTicketFocus,
    ),
  );

  // Supplementary: all headline tiers together.
  lines.push(
    ...renderFocusTable(
      "### Supplementary — all headline strata (every prompt tier)",
      "Same comparisons over all headline tasks regardless of prompt tier (includes saturated/underspecified/context-required). Directional context only — not the headline claim.",
      a.focusVerdicts,
    ),
  );

  // Prompt-tier breakdown.
  if (a.perPromptTier.length > 0) {
    lines.push(...renderPerPromptTier(a.perPromptTier, a.primaryArms));
  }

  // Headline pass rate by arm (every arm present, incl. control + clipped).
  lines.push("### Headline pass rate by arm (S1–S5)");
  lines.push("");
  lines.push("| Arm | Pass rate | Avg score |");
  lines.push("| --- | ---: | ---: |");
  for (const s of a.allArmSummaries) {
    if (s.total === 0) continue;
    lines.push(`| ${s.arm} | ${pctOf(s)} | ${s.avgScore.toFixed(2)} |`);
  }
  lines.push("");

  // Per-stratum.
  if (a.perStratum.length > 0) {
    lines.push(...renderPerStratum(a.perStratum, a.primaryArms));
  }

  // LIC-quality sensitivity (pim-full vs lic-full delta per slice).
  if (a.licQualitySensitivity.length > 0) {
    lines.push(...renderSensitivity(a.licQualitySensitivity));
  }

  // Secondary strata.
  const secondary = a.secondaryArmSummaries.filter((s) => s.total > 0);
  if (secondary.length > 0) {
    lines.push("### Secondary strata (S6 — exploratory only, not in headline)");
    lines.push("");
    lines.push("Locally indexed code structurally has the answer here by construction; reported separately.");
    lines.push("");
    lines.push("| Arm | Pass rate | Avg score |");
    lines.push("| --- | ---: | ---: |");
    for (const s of secondary) lines.push(`| ${s.arm} | ${pctOf(s)} | ${s.avgScore.toFixed(2)} |`);
    lines.push("");
  }

  return lines;
}

function renderFocusTable(title: string, note: string, focus: FocusVerdict[]): string[] {
  const lines: string[] = [];
  lines.push(title);
  lines.push("");
  lines.push(note);
  lines.push("q is the Benjamini-Hochberg adjusted value across the primary family; standalone pairs show the raw two-sided p.");
  lines.push("");
  lines.push("| Comparison | n | Mean Δ (pp) | 95% CI (pp) | Cohen's dz | q / p | Severe regr. | Verdict |");
  lines.push("| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |");
  const missing: FocusVerdict[] = [];
  for (const f of focus) {
    const c = f.comparison;
    if (!c) {
      missing.push(f);
      continue;
    }
    lines.push(
      `| ${f.label} | ${c.n} | ${pp(c.meanDeltaPp)} | [${c.ciLowPp.toFixed(1)}, ${c.ciHighPp.toFixed(1)}] | ` +
        `${c.cohensD.toFixed(2)} (${c.effectBucket}) | ${qCol(c)} | ${(c.severeRegressionRate * 100).toFixed(0)}% | ${VERDICT_LABEL[c.verdict]} |`,
    );
  }
  lines.push("");
  if (missing.length > 0) {
    lines.push(`_No paired data for: ${missing.map((m) => m.label).join("; ")}._`);
    lines.push("");
  }
  return lines;
}

function renderPerPromptTier(tiers: PromptTierAnalysis[], arms: string[]): string[] {
  const lines: string[] = [];
  lines.push("### Pass rate by prompt-realism tier (headline)");
  lines.push("");
  lines.push("Headline claim is read on `realistic-ticket`. `saturated` is a sanity check, `underspecified` a context-discovery probe, `context-required` a PIM mechanism test.");
  lines.push("");
  lines.push(`| Tier | n tasks | ${arms.join(" | ")} |`);
  lines.push(`| --- | ---: | ${arms.map(() => "---:").join(" | ")} |`);
  for (const t of tiers) {
    const cells = arms.map((arm) => {
      const s = t.armSummaries.find((x) => x.arm === arm);
      return s && s.total > 0 ? `${(s.passRate * 100).toFixed(0)}%` : "—";
    });
    lines.push(`| ${t.tier} | ${t.taskCount} | ${cells.join(" | ")} |`);
  }
  lines.push("");
  return lines;
}

function renderPerStratum(perStratum: StratumAnalysis[], arms: string[]): string[] {
  const lines: string[] = [];
  lines.push("### Per-stratum pass rate (headline)");
  lines.push("");
  lines.push(`| Stratum | n tasks | ${arms.join(" | ")} |`);
  lines.push(`| --- | ---: | ${arms.map(() => "---:").join(" | ")} |`);
  for (const s of perStratum) {
    const cells = arms.map((arm) => {
      const summary = s.armSummaries.find((x) => x.arm === arm);
      return summary && summary.total > 0 ? `${(summary.passRate * 100).toFixed(0)}%` : "—";
    });
    lines.push(`| ${s.stratum} | ${s.taskCount} | ${cells.join(" | ")} |`);
  }
  lines.push("");
  return lines;
}

function renderSensitivity(slices: SensitivityAnalysis[]): string[] {
  const lines: string[] = [];
  lines.push("### Locally-indexed-code quality sensitivity");
  lines.push("");
  lines.push("PIM-full vs locally-indexed-code delta as fixtures of increasing quality are excluded, to show the headline isn't carried by weak/leaky comparator fixtures.");
  lines.push("");
  lines.push("| Slice | n tasks | PIM vs lic Δ (pp) | 95% CI (pp) | Verdict |");
  lines.push("| --- | ---: | ---: | ---: | --- |");
  for (const slice of slices) {
    const c = findComparison(slice.comparisons, "pim-full", "lic-full");
    if (!c) {
      lines.push(`| ${slice.label} | ${slice.taskCount} | — | — | — |`);
      continue;
    }
    lines.push(`| ${slice.label} | ${slice.taskCount} | ${pp(c.meanDeltaPp)} | [${c.ciLowPp.toFixed(1)}, ${c.ciHighPp.toFixed(1)}] | ${VERDICT_LABEL[c.verdict]} |`);
  }
  lines.push("");
  return lines;
}

function findComparison(comparisons: ProtocolComparison[], armA: string, armB: string): ProtocolComparison | undefined {
  const direct = comparisons.find((c) => c.armA === armA && c.armB === armB);
  if (direct) return direct;
  const reverse = comparisons.find((c) => c.armA === armB && c.armB === armA);
  if (!reverse) return undefined;
  return {
    ...reverse,
    armA,
    armB,
    meanDeltaPp: -reverse.meanDeltaPp,
    ciLowPp: -reverse.ciHighPp,
    ciHighPp: -reverse.ciLowPp,
    cohensD: -reverse.cohensD,
  };
}
