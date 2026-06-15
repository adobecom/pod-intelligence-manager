import { describe, it, expect } from "vitest";
import { renderMarkdownReport, renderPatchBuildabilitySection, type EvalRow } from "../report.js";
import { computeProtocolAnalysis } from "../rigor/protocol-analysis.js";

function row(overrides: Partial<EvalRow>): EvalRow {
  return {
    taskId: "t1",
    taskType: "code",
    podId: "pod-emc-rbac",
    arm: "control",
    armLabel: "Control (no PIM)",
    runner: "anthropic",
    model: "claude-sonnet-4-6",
    output: "...",
    usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheCreationTokens: 0 },
    latencyMs: 1200,
    judge: { passed: true, score: 1, detail: "all 3 tests passed" },
    costUsd: 0.0001,
    signalsHit: [],
    ...overrides,
  };
}

describe("renderMarkdownReport", () => {
  it("renders headline summary, per-task table, and reproduction footer", () => {
    const rows = [
      row({ taskId: "t1", arm: "control", armLabel: "Control (no PIM)", judge: { passed: false, score: 0, detail: "test failed" } }),
      row({ taskId: "t1", arm: "pim-full", armLabel: "PIM-full", usage: { inputTokens: 4000, outputTokens: 50, cacheReadTokens: 0, cacheCreationTokens: 4000 } }),
      row({ taskId: "t2", arm: "control", armLabel: "Control (no PIM)" }),
      row({ taskId: "t2", arm: "pim-full", armLabel: "PIM-full", usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 4000, cacheCreationTokens: 0 } }),
    ];
    const md = renderMarkdownReport(rows, {
      generatedAt: "2026-05-08T00:00:00Z",
      runner: "anthropic",
      model: "claude-sonnet-4-6",
      judgeModel: "claude-opus-4-7",
      filter: {},
    });
    expect(md).toContain("# PIM Eval Report");
    expect(md).toContain("## Summary by arm");
    expect(md).toContain("PILOT / AD-HOC RUN");
    expect(md).toContain("## Task selection");
    expect(md).toContain("Selected tasks: 2");
    expect(md).toContain("Control (no PIM)");
    expect(md).toContain("PIM-full");
    expect(md).toContain("## Per-task results");
    expect(md).toContain("## Reproduction");
    expect(md).toContain("claude-sonnet-4-6");
    expect(md).toContain("claude-opus-4-7");
  });

  it("flags a PIM-saves case when control fails and PIM passes", () => {
    const rows = [
      row({ taskId: "t1", arm: "control", armLabel: "Control (no PIM)", judge: { passed: false, score: 0, detail: "wrong endpoint" } }),
      row({ taskId: "t1", arm: "pim-full", armLabel: "PIM-full", judge: { passed: true, score: 1, detail: "ok" } }),
    ];
    const md = renderMarkdownReport(rows, {
      generatedAt: "2026-05-08T00:00:00Z",
      runner: "anthropic",
      model: "claude-sonnet-4-6",
      judgeModel: "claude-opus-4-7",
      filter: {},
    });
    expect(md).toContain("PIM saves");
    expect(md).toContain("t1");
    expect(md).toContain("wrong endpoint");
  });

  it("uses kg-only for comparison diagnostics when pim-full is absent", () => {
    const rows = [
      row({
        taskId: "t1",
        tags: ["housestyle"],
        arm: "control",
        armLabel: "Control (no PIM)",
        judge: { passed: true, score: 1, detail: "ok" },
      }),
      row({
        taskId: "t1",
        tags: ["housestyle"],
        arm: "kg-only",
        armLabel: "KG-only",
        judge: { passed: false, score: 0.2, detail: "missed convention" },
      }),
    ];
    const md = renderMarkdownReport(rows, {
      generatedAt: "2026-05-08T00:00:00Z",
      runner: "anthropic",
      model: "claude-sonnet-4-6",
      judgeModel: "claude-opus-4-7",
      filter: {},
    });
    expect(md).toContain("Pass rate by category (KG-only vs. control)");
    expect(md).toContain("KG-only pass");
    expect(md).toContain("(0/1)");
    expect(md).toContain("KG-only regressions");
    expect(md).toContain("missed convention");
    expect(md).not.toContain("PIM pass");
  });

  it("uses sample totals instead of task count in multi-seed category rows", () => {
    const rows = [
      row({ taskId: "t1", tags: ["housestyle"], arm: "control", armLabel: "Control (no PIM)", seed: 0, judge: { passed: true, score: 1, detail: "ok" } }),
      row({ taskId: "t1", tags: ["housestyle"], arm: "control", armLabel: "Control (no PIM)", seed: 1, judge: { passed: false, score: 0, detail: "miss" } }),
      row({ taskId: "t1", tags: ["housestyle"], arm: "kg-only", armLabel: "KG-only", seed: 0, judge: { passed: true, score: 1, detail: "ok" } }),
      row({ taskId: "t1", tags: ["housestyle"], arm: "kg-only", armLabel: "KG-only", seed: 1, judge: { passed: true, score: 1, detail: "ok" } }),
    ];
    const md = renderMarkdownReport(rows, {
      generatedAt: "2026-05-08T00:00:00Z",
      runner: "anthropic",
      model: "claude-sonnet-4-6",
      judgeModel: "claude-opus-4-7",
      filter: {},
    });
    expect(md).toContain("50% (1/2)");
    expect(md).toContain("100% (2/2)");
    expect(md).not.toContain("100% (2/1)");
  });

  it("computes a non-zero cache hit rate when cacheReadTokens are present", () => {
    const rows = [
      row({ arm: "pim-full", armLabel: "PIM-full", usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 4000, cacheCreationTokens: 0 } }),
      row({ arm: "pim-full", armLabel: "PIM-full", usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 4000, cacheCreationTokens: 0 } }),
    ];
    const md = renderMarkdownReport(rows, {
      generatedAt: "2026-05-08T00:00:00Z",
      runner: "anthropic",
      model: "claude-sonnet-4-6",
      judgeModel: "claude-opus-4-7",
      filter: {},
    });
    // Two rows, each 4000 cache reads against 100 input tokens, hit rate 4000/4100 = 97-98%.
    expect(md).toMatch(/97%|98%|95%|96%|99%/);
  });

  it("uses realistic-ticket headline rows for protocol executive bullets", () => {
    const rows = [
      row({ taskId: "realistic", stratum: "S1", promptTier: "realistic-ticket", arm: "control", armLabel: "Control", judge: { passed: false, score: 0, detail: "miss" } }),
      row({ taskId: "realistic", stratum: "S1", promptTier: "realistic-ticket", arm: "pim-full", armLabel: "PIM-full", judge: { passed: true, score: 1, detail: "ok" } }),
      row({ taskId: "saturated", stratum: "S1", promptTier: "saturated", arm: "control", armLabel: "Control", judge: { passed: true, score: 1, detail: "ok" } }),
      row({ taskId: "saturated", stratum: "S1", promptTier: "saturated", arm: "pim-full", armLabel: "PIM-full", judge: { passed: false, score: 0, detail: "miss" } }),
    ];
    const md = renderMarkdownReport(rows, {
      generatedAt: "2026-05-08T00:00:00Z",
      runner: "anthropic",
      model: "claude-sonnet-4-6",
      judgeModel: "claude-opus-4-7",
      filter: {},
      protocol: computeProtocolAnalysis(rows, { bootstrapIterations: 100, primaryArms: ["pim-full"] }),
    });
    expect(md).toContain("bullets use realistic-ticket S1-S5 tasks only");
    expect(md).toContain("PIM lifts pass rate by 100pp");
    expect(md).not.toContain("Pass rate tied at 50%");
  });

  it("separates diff-format diagnostics from semantic rubric score", () => {
    const rows = [
      row({
        taskId: "t1",
        taskType: "content",
        arm: "control",
        armLabel: "Control",
        judge: {
          passed: true,
          score: 0.6,
          detail: "ok",
          rubricScores: { contract: 1, valid_unified_diff: 0 },
        },
      }),
    ];
    const md = renderMarkdownReport(rows, {
      generatedAt: "2026-05-08T00:00:00Z",
      runner: "anthropic",
      model: "claude-sonnet-4-6",
      judgeModel: "claude-opus-4-7",
      filter: {},
    });
    expect(md).toContain("## Diff format diagnostics");
    expect(md).toContain("| Control | 1 | 1.00 | 0.00 | 0% (0/1) | 100% (1/1) |");
  });

  it("renders patch buildability rows", () => {
    const md = renderPatchBuildabilitySection([
      {
        taskId: "t1",
        arm: "kg-only",
        seed: 0,
        patch: {
          diffExtracted: true,
          checked: true,
          skipped: false,
          applies: true,
          buildability: 1,
          reason: "diff applies cleanly",
        },
      },
    ]).join("\n");
    expect(md).toContain("## Patch buildability");
    expect(md).toContain("| kg-only | 1 | 1/1 | 1/1 | not run | 0 | 1.00 |");
    expect(md).toContain("| t1 | kg-only | 0 | yes | yes | not run | diff applies cleanly |");
  });
});
