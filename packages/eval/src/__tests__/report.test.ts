import { describe, it, expect } from "vitest";
import { renderMarkdownReport, type EvalRow } from "../report.js";

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
});
