import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import type { Task } from "../tasks/types.js";
import {
  hashTaskGroundTruth,
  hashTaskPrompt,
  hashTaskRubric,
  validateHoldoutManifest,
  type HoldoutManifest,
} from "../rigor/holdout.js";
import { sha256Text, stableJson } from "../rigor/hash.js";

function task(): Task {
  return {
    id: "task-1",
    type: "content",
    podId: "pod",
    prompt: "Explain the event save fix.",
    stratum: "S1",
    tags: ["real-emc"],
    asOf: "2026-05-01T00:00:00Z",
    provenance: { parentSha: "parent-1", mergeSha: "merge-1", sourceUrl: "https://example.test/pr/1" },
    licSeed: { symbol: "saveEvent", investigateQuery: "event save fix" },
    rubric: {
      id: "rubric",
      criteria: [{ id: "correct", description: "correct", scale: "0-5", weight: 1 }],
    },
    groundTruth: { output: "reference answer" },
  };
}

describe("validateHoldoutManifest", () => {
  it("fails on prompt, rubric, ground-truth, stratum, lic seed, and lic fixture drift", async () => {
    const t = task();
    const fixtureDir = await mkdtemp(join(tmpdir(), "pim-eval-holdout-"));
    await writeFile(join(fixtureDir, `${t.id}.json`), "{\"fixture\":true,\"indexSource\":{\"kind\":\"head\",\"repo\":\"/repo\"}}");

    const manifest: HoldoutManifest = {
      id: "holdout",
      protocol: "protocols/pim-vs-lic-haiku-v2.md",
      minimumTaskCount: 30,
      createdAt: "2026-06-01T00:00:00Z",
      tasks: [
        {
          id: t.id,
          promptHash: `${hashTaskPrompt(t)}-drift`,
          groundTruthHash: `${hashTaskGroundTruth(t)}-drift`,
          rubricHash: `${hashTaskRubric(t)}-drift`,
          stratum: "S2",
          promptTier: "underspecified",
          asOf: "2026-04-01T00:00:00Z",
          provenance: { parentSha: "wrong-parent" },
          licSeedHash: `${sha256Text(stableJson(t.licSeed))}-drift`,
          licFixtureHash: "wrong-fixture-hash",
          objectiveClass: {
            taskType: "content",
            hasGroundTruth: true,
            promptChars: t.prompt.length,
            groundTruthChars: t.groundTruth?.output.length ?? 0,
            sourceTagSnapshot: [],
          },
        },
      ],
    };

    const result = await validateHoldoutManifest(manifest, { tasks: [t], licFixtureDir: fixtureDir });
    const messages = result.findings.map((finding) => finding.message).join("\n");
    expect(result.ok).toBe(false);
    expect(messages).toContain("prompt hash drift");
    expect(messages).toContain("ground truth hash drift");
    expect(messages).toContain("rubric hash drift");
    expect(messages).toContain("stratum drift");
    expect(messages).toContain("prompt tier drift");
    expect(messages).toContain("asOf drift");
    expect(messages).toContain("provenance snapshot drift");
    expect(messages).toContain("lic seed hash drift");
    expect(messages).toContain("lic fixture hash drift");
    expect(messages).toContain("head-indexed");
  });

  it("fails non-exploratory haiku-v2 holdouts with too few realistic-ticket tasks or HEAD-indexed LIC fixtures", async () => {
    const t = task();
    const fixtureDir = await mkdtemp(join(tmpdir(), "pim-eval-holdout-"));
    const raw = JSON.stringify({ taskId: t.id, indexSource: { kind: "head", repo: "/repo" }, renderedBlock: "" });
    await writeFile(join(fixtureDir, `${t.id}.json`), raw);

    const manifest: HoldoutManifest = {
      id: "holdout",
      protocol: "protocols/pim-vs-lic-haiku-v2.md",
      minimumTaskCount: 30,
      createdAt: "2026-06-01T00:00:00Z",
      tasks: [
        {
          id: t.id,
          promptHash: hashTaskPrompt(t),
          groundTruthHash: hashTaskGroundTruth(t),
          rubricHash: hashTaskRubric(t),
          asOf: t.asOf,
          promptTier: "realistic-ticket",
          stratum: t.stratum,
          provenance: t.provenance,
          licSeedHash: sha256Text(stableJson(t.licSeed)),
          licFixtureHash: sha256Text(raw),
          licIndexSource: { kind: "head", repo: "/repo" },
          objectiveClass: {
            taskType: "content",
            hasGroundTruth: true,
            promptChars: t.prompt.length,
            groundTruthChars: t.groundTruth?.output.length ?? 0,
            sourceTagSnapshot: t.tags ?? [],
          },
        },
      ],
    };

    const result = await validateHoldoutManifest(manifest, { tasks: [t], licFixtureDir: fixtureDir });
    const messages = result.findings.map((finding) => finding.message).join("\n");
    expect(result.ok).toBe(false);
    expect(messages).toContain("primary claim has 1 realistic-ticket headline tasks");
    expect(messages).toContain("must be parentSha-indexed");
  });

  it("fails haiku holdouts that snapshot weak LIC fixtures", async () => {
    const t = task();
    const fixtureDir = await mkdtemp(join(tmpdir(), "pim-eval-holdout-"));
    const raw = JSON.stringify({
      taskId: t.id,
      indexSource: { kind: "parentSha", sha: t.provenance?.parentSha, worktree: "/repo-parent" },
      renderedBlock: "Found 5 results\n\n1. web-src/src/other/File.ts (lines 1-20)\nSome unrelated code.",
      quality: {
        signal: "weak",
        noDefinitionResult: false,
        answerLeak: false,
        intentMatch: false,
        primaryFileRetrieved: false,
        groundTruthSymbolOrChunkRetrieved: false,
      },
    });
    await writeFile(join(fixtureDir, `${t.id}.json`), raw);

    const manifest: HoldoutManifest = {
      id: "holdout",
      protocol: "protocols/pim-vs-lic-haiku-v2.md",
      minimumTaskCount: 30,
      createdAt: "2026-06-01T00:00:00Z",
      tasks: [
        {
          id: t.id,
          promptHash: hashTaskPrompt(t),
          groundTruthHash: hashTaskGroundTruth(t),
          rubricHash: hashTaskRubric(t),
          asOf: t.asOf,
          promptTier: "realistic-ticket",
          stratum: t.stratum,
          provenance: t.provenance,
          licSeedHash: sha256Text(stableJson(t.licSeed)),
          licFixtureHash: sha256Text(raw),
          licIndexSource: { kind: "parentSha", sha: t.provenance!.parentSha!, worktree: "/repo-parent" },
          objectiveClass: {
            taskType: "content",
            hasGroundTruth: true,
            promptChars: t.prompt.length,
            groundTruthChars: t.groundTruth?.output.length ?? 0,
            sourceTagSnapshot: t.tags ?? [],
          },
        },
      ],
    };

    const result = await validateHoldoutManifest(manifest, { tasks: [t], licFixtureDir: fixtureDir });
    expect(result.ok).toBe(false);
    expect(result.findings.map((finding) => finding.message).join("\n")).toContain("signal=weak");
  });
});
