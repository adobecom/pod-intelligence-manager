import { describe, it, expect } from "vitest";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pimFullArm } from "../arms/index.js";
import { filterFixtureByAsOf } from "../arms/pim-full.js";
import { pimClippedArm, licClippedArm } from "../arms/clipped.js";
import type { EvalRow } from "../report.js";
import type { SessionContextFixture, LicContextFixture } from "../arms/types.js";
import type { Task } from "../tasks/types.js";
import { EMPTY_USAGE } from "../runners/types.js";
import { extractUnifiedDiff } from "../judges/patch.js";
import { classifyPromptTier } from "../tasks/prompt-tiers.js";
import { computeProtocolAnalysis } from "../rigor/protocol-analysis.js";
import { renderProtocolReport } from "../rigor/protocol-report.js";
import { auditJudging } from "../rigor/run-audits.js";

const ASOF = "2026-04-01T00:00:00Z";

function fixtureWithTimestamps(): SessionContextFixture {
  return {
    podId: "pod-x",
    pulledAt: "2026-06-01T00:00:00Z",
    payload: {
      pod: { pod_id: "pod-x", name: "X" },
      livingDocMarkdown: "doc body",
      conflicts: [
        { id: "C-1", summary: "untimestamped conflict", severity: "low", status: "open", sides: [], master_analysis: "", impact: [] },
        { id: "C-2", summary: "future conflict", severity: "low", status: "open", sides: [], master_analysis: "", impact: [], created_at: "2026-05-01T00:00:00Z" },
      ],
      relevantLearnings: {
        nodes: [
          { type: "pattern", summary: "old learning", details: "", domains: [], confidence_score: 0.9 },
          { type: "pattern", summary: "future learning", details: "", domains: [], confidence_score: 0.9, created_at: "2026-05-01T00:00:00Z" },
        ],
        total_matching: 2,
        truncated: false,
      },
      recentUpdates: [
        { agent_id: "a", timestamp: "2026-03-01T00:00:00Z", type: "progress", summary: "old update", details: "", status: "ok" },
        { agent_id: "a", timestamp: "2026-05-01T00:00:00Z", type: "progress", summary: "future update", details: "", status: "ok" },
      ],
    },
  };
}

const contentTask = (over: Partial<Task> = {}): Task =>
  ({ id: "t1", type: "content", podId: "pod-x", prompt: "do the thing", asOf: ASOF, ...over }) as Task;

describe("filterFixtureByAsOf (#3 temporal scoping)", () => {
  it("drops post-asOf updates, timestamped conflicts and learnings; keeps untimestamped; stamps asOf", () => {
    const out = filterFixtureByAsOf(fixtureWithTimestamps(), ASOF);
    expect(out.asOf).toBe(ASOF);
    expect(out.payload.recentUpdates.map((u) => u.summary)).toEqual(["old update"]);
    expect(out.payload.conflicts.map((c) => c.id)).toEqual(["C-1"]); // untimestamped passes through
    expect(out.payload.relevantLearnings.nodes.map((n) => n.summary)).toEqual(["old learning"]);
    expect(out.payload.relevantLearnings.total_matching).toBe(1);
  });

  it("pim-full applies the asOf cutoff and shows the point-in-time line", () => {
    const ctx = pimFullArm.build(contentTask(), fixtureWithTimestamps()).pimContext ?? "";
    expect(ctx).toContain(`Point-in-time as of ${ASOF}`);
    expect(ctx).toContain("old update");
    expect(ctx).not.toContain("future update");
    expect(ctx).not.toContain("future conflict");
  });
});

describe("matched-budget clipped arms (#10)", () => {
  it("lic-clipped truncates a long block to the matched budget", () => {
    const lic: LicContextFixture = { taskId: "t1", renderedBlock: "x".repeat(5000) };
    const ctx = licClippedArm.buildWithInputs!(contentTask(), { pim: null, lic }).pimContext ?? "";
    expect(ctx.length).toBeLessThanOrEqual(2000);
    expect(ctx).toContain("truncated to matched budget");
  });

  it("pim-clipped still applies the asOf cutoff", () => {
    const ctx = pimClippedArm.build(contentTask(), fixtureWithTimestamps()).pimContext ?? "";
    expect(ctx).not.toContain("future update");
  });
});

describe("extractUnifiedDiff (#9 patch judge)", () => {
  it("pulls a fenced diff", () => {
    const out = extractUnifiedDiff("```diff\ndiff --git a/x b/x\n@@ -1 +1 @@\n-a\n+b\n```");
    expect(out).toContain("diff --git");
  });
  it("accepts a raw diff body", () => {
    expect(extractUnifiedDiff("--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n")).toContain("@@");
  });
  it("returns null for prose", () => {
    expect(extractUnifiedDiff("Here is a description with no diff at all.")).toBeNull();
  });
});

describe("classifyPromptTier (#8)", () => {
  it("uses the tier map, explicit field, and tag heuristic", () => {
    expect(classifyPromptTier({ id: "real-emc-event-form-route-with-event-id" } as Task)).toBe("realistic-ticket");
    expect(classifyPromptTier({ id: "real-emc-session-time-no-refresh" } as Task)).toBe("underspecified");
    expect(classifyPromptTier({ id: "synth-event-route-after-create" } as Task)).toBe("context-required");
    expect(classifyPromptTier({ id: "unknown", tags: ["saturated"] } as Task)).toBe("saturated");
    expect(classifyPromptTier({ id: "unknown2", promptTier: "context-required" } as Task)).toBe("context-required");
  });
});

function row(taskId: string, arm: string, passed: boolean, promptTier = "realistic-ticket"): EvalRow {
  return {
    taskId, taskType: "content", podId: "p", arm, armLabel: arm, runner: "bedrock", model: "m",
    output: "", usage: EMPTY_USAGE, latencyMs: 1, judge: { passed, score: passed ? 1 : 0, detail: "" },
    costUsd: 0, signalsHit: [], stratum: "S1", promptTier,
  };
}

describe("protocol analysis + report (#6, #10, #11)", () => {
  const rows: EvalRow[] = [];
  for (const t of ["A", "B", "C"]) {
    rows.push(row(t, "pim-full", true));
    rows.push(row(t, "length-matched-neutral", t === "A"));
    rows.push(row(t, "control", t !== "C"));
    rows.push(row(t, "lic-full", t === "A"));
  }
  rows.push(row("D", "pim-full", false, "saturated"));
  rows.push(row("D", "length-matched-neutral", false, "saturated"));
  const analysis = computeProtocolAnalysis(rows, {
    bootstrapIterations: 200,
    primaryArms: ["pim-full", "kg-only", "lic-full", "lic-pim-combined", "length-matched-neutral"],
  });

  it("includes both baselines in the focus verdicts", () => {
    const labels = analysis.focusVerdicts.map((f) => `${f.armA}|${f.armB}`);
    expect(labels).toContain("pim-full|length-matched-neutral");
    expect(labels).toContain("pim-full|control");
  });

  it("summarizes control (not a primary arm) in allArmSummaries", () => {
    expect(analysis.allArmSummaries.some((s) => s.arm === "control" && s.total > 0)).toBe(true);
  });

  it("computes a realistic-ticket-only headline focus and a per-tier breakdown", () => {
    expect(analysis.realisticTicketTaskCount).toBe(3); // A, B, C (D is saturated)
    expect(analysis.realisticTicketFocus.some((f) => f.comparison)).toBe(true);
    expect(analysis.perPromptTier.some((t) => t.tier === "realistic-ticket")).toBe(true);
    expect(analysis.perPromptTier.some((t) => t.tier === "saturated")).toBe(true);
  });

  it("renders the protocol claim sections in markdown", () => {
    const md = renderProtocolReport(analysis).join("\n");
    expect(md).toContain("## Protocol Claim Analysis");
    expect(md).toContain("Headline claim — realistic-ticket tasks only");
    expect(md).toContain("Pass rate by prompt-realism tier");
    expect(md).toContain("length-matched neutral (primary baseline)");
  });
});

describe("auditJudging patch-judge enforcement (#9)", () => {
  it("requires real-EMC diff tasks to have checked patch-judge rows", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "pim-eval-run-"));
    await mkdir(runDir, { recursive: true });
    await writeFile(
      join(runDir, "manifest.json"),
      JSON.stringify({ runId: "r1", tasks: ["real-emc-prod-publish-confirmation"] }),
    );
    await writeFile(join(runDir, "human-review.jsonl"), JSON.stringify({ kappa: 0.8 }) + "\n");
    await writeFile(
      join(runDir, "outputs.jsonl"),
      JSON.stringify({ taskId: "real-emc-prod-publish-confirmation", arm: "pim-full", seed: 0 }) + "\n",
    );

    const missing = await auditJudging(runDir);
    expect(missing.ok).toBe(false);
    expect(missing.findings.map((f) => f.message).join("\n")).toContain("patch-judge.jsonl");

    await writeFile(
      join(runDir, "patch-judge.jsonl"),
      JSON.stringify({
        taskId: "real-emc-prod-publish-confirmation",
        arm: "pim-full",
        seed: 0,
        patch: { checked: false, skipped: true, reason: "missing repo" },
      }) + "\n",
    );
    const skipped = await auditJudging(runDir);
    expect(skipped.ok).toBe(false);
    expect(skipped.findings.map((f) => f.message).join("\n")).toContain("contains no checked rows");

    await writeFile(
      join(runDir, "patch-judge.jsonl"),
      JSON.stringify({
        taskId: "real-emc-prod-publish-confirmation",
        arm: "pim-full",
        seed: 0,
        patch: { checked: true, skipped: false, applies: true, reason: "ok" },
      }) + "\n",
    );
    expect((await auditJudging(runDir)).ok).toBe(true);
  });
});
