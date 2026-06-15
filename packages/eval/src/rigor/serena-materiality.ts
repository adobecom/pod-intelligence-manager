import type { SerenaContextFixture, SerenaFixtureQuality, SerenaFixtureSignal } from "../serena/types.js";
import type { Task } from "../tasks/types.js";
import { deriveSerenaFixtureQuality } from "./serena-quality.js";

/**
 * Serena evidence/materiality, used by the report's Serena section. Each row is
 * the per-task evidence breakdown the plan's "Evidence Metrics" call for; the
 * summary is the fixture-quality distribution used by the analysis gate
 * (≥75% medium/strong on headline tasks).
 */
export interface SerenaMaterialityRow {
  taskId: string;
  stratum?: string;
  signal: SerenaFixtureSignal;
  symbolEvidenceRetrieved: boolean;
  referencesRetrieved: boolean;
  primaryFileRetrieved: boolean;
  diagnosticsCaptured: boolean;
  intentMatch: boolean;
  answerLeak: boolean;
}

export function evaluateSerenaMateriality(task: Task, fixture: SerenaContextFixture): SerenaMaterialityRow {
  const quality: SerenaFixtureQuality = fixture.quality ?? deriveSerenaFixtureQuality(task, fixture);
  return {
    taskId: task.id,
    stratum: task.stratum,
    signal: quality.signal,
    symbolEvidenceRetrieved: quality.symbolEvidenceRetrieved,
    referencesRetrieved: quality.referencesRetrieved,
    primaryFileRetrieved: quality.primaryFileRetrieved,
    diagnosticsCaptured: quality.diagnosticsCaptured,
    intentMatch: quality.intentMatch,
    answerLeak: quality.answerLeak,
  };
}

const ALL_SIGNALS: SerenaFixtureSignal[] = ["none", "weak", "medium", "strong", "leak"];

export function summarizeSerenaQuality(
  quality: Iterable<SerenaFixtureQuality | undefined>,
): Record<SerenaFixtureSignal, number> {
  const counts = Object.fromEntries(ALL_SIGNALS.map((s) => [s, 0])) as Record<SerenaFixtureSignal, number>;
  for (const q of quality) {
    if (q) counts[q.signal] += 1;
  }
  return counts;
}

/** Fraction of fixtures that are medium/strong (the headline fixture-quality gate). */
export function readyFraction(counts: Record<SerenaFixtureSignal, number>): number {
  const total = ALL_SIGNALS.reduce((s, k) => s + counts[k], 0);
  if (total === 0) return 0;
  return (counts.medium + counts.strong) / total;
}
