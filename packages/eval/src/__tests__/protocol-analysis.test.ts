import { describe, expect, it } from "vitest";
import type { EvalRow } from "../report.js";
import { computeProtocolAnalysis, PRIMARY_PROTOCOL_ARMS } from "../rigor/protocol-analysis.js";
import { severeRegressionRate } from "../rigor/pairwise.js";
import type { LicFixtureQuality } from "../rigor/lic-quality.js";

const QUALITY: Record<string, LicFixtureQuality> = {
  none: {
    signal: "none",
    noDefinitionResult: true,
    answerLeak: false,
    intentMatch: false,
    primaryFileRetrieved: false,
    groundTruthSymbolOrChunkRetrieved: false,
  },
  leak: {
    signal: "leak",
    noDefinitionResult: false,
    answerLeak: true,
    intentMatch: true,
    primaryFileRetrieved: true,
    groundTruthSymbolOrChunkRetrieved: true,
  },
  medium: {
    signal: "medium",
    noDefinitionResult: false,
    answerLeak: false,
    intentMatch: true,
    primaryFileRetrieved: false,
    groundTruthSymbolOrChunkRetrieved: false,
  },
};

function row(overrides: Partial<EvalRow>): EvalRow {
  return {
    taskId: "t1",
    taskType: "content",
    podId: "pod-emc",
    arm: "pim-full",
    armLabel: "PIM-full",
    runner: "bedrock",
    model: "model",
    output: "out",
    usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0 },
    latencyMs: 1,
    judge: { passed: true, score: 1, detail: "ok" },
    costUsd: 0,
    signalsHit: [],
    stratum: "S1",
    promptTier: "realistic-ticket",
    licFixtureHash: "hash",
    licFixtureQuality: QUALITY.medium,
    ...overrides,
  };
}

describe("protocol analysis", () => {
  it("returns all six comparisons for the four primary arms", () => {
    const rows = ["t1", "t2"].flatMap((taskId) =>
      PRIMARY_PROTOCOL_ARMS.map((arm) => row({ taskId, arm, armLabel: arm })),
    );
    const analysis = computeProtocolAnalysis(rows, { bootstrapIterations: 100, generatedAt: "now" });
    expect(analysis.comparisons).toHaveLength(6);
    expect(analysis.headlineTaskCount).toBe(2);
  });

  it("builds lic-quality sensitivity slices that drop none and leak fixtures", () => {
    const taskQuality = { t1: QUALITY.none, t2: QUALITY.leak, t3: QUALITY.medium };
    const rows = Object.entries(taskQuality).flatMap(([taskId, quality]) =>
      PRIMARY_PROTOCOL_ARMS.map((arm) => row({ taskId, arm, armLabel: arm, licFixtureQuality: quality })),
    );
    const analysis = computeProtocolAnalysis(rows, { bootstrapIterations: 100, generatedAt: "now" });
    const byId = new Map(analysis.licQualitySensitivity.map((slice) => [slice.id, slice]));
    expect(byId.get("all-headline")?.taskCount).toBe(3);
    expect(byId.get("exclude-none")?.taskCount).toBe(2);
    expect(byId.get("exclude-leak")?.taskCount).toBe(2);
    expect(byId.get("high-signal")?.taskCount).toBe(1);
  });

  it("uses normalized-score severe regression threshold", () => {
    const rows = [
      row({ taskId: "t1", arm: "treatment", judge: { passed: false, score: 0.3, detail: "miss" } }),
      row({ taskId: "t1", arm: "comparator", judge: { passed: true, score: 0.8, detail: "ok" } }),
      row({ taskId: "t2", arm: "treatment", judge: { passed: true, score: 0.5, detail: "weak pass" } }),
      row({ taskId: "t2", arm: "comparator", judge: { passed: true, score: 0.95, detail: "ok" } }),
    ];
    expect(severeRegressionRate(rows, "treatment", "comparator")).toBe(1);
  });
});
