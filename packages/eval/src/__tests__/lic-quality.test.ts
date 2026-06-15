import { describe, expect, it } from "vitest";
import type { LicContextFixture } from "../arms/types.js";
import {
  deriveLicFixtureQuality,
  describeLicFixtureQualityGate,
  extractGroundTruthChunks,
  extractGroundTruthFiles,
  extractGroundTruthSymbols,
  extractIdentifiers,
  extractTaskContractEvidence,
  isLicFixtureQualityReady,
  isLikelyAnswerSymbol,
} from "../rigor/lic-quality.js";
import type { Task } from "../tasks/types.js";

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: "task",
    type: "content",
    podId: "pod",
    prompt: "Fix the event save behavior for the event form.",
    tags: ["real-emc"],
    stratum: "S1",
    licSeed: { symbol: "saveEvent", investigateQuery: "event save behavior" },
    groundTruth: {
      output: [
        "diff --git a/web-src/src/forms/EventForm.tsx b/web-src/src/forms/EventForm.tsx",
        "+++ b/web-src/src/forms/EventForm.tsx",
        "@@",
        "+const mergedEventSavePayload = buildPayloadForEventSave(formState)",
      ].join("\n"),
    },
    ...overrides,
  };
}

function fixture(renderedBlock: string): LicContextFixture {
  return {
    taskId: "task",
    recipe: ["search"],
    renderedBlock,
  };
}

describe("deriveLicFixtureQuality", () => {
  it("classifies no-definition fixtures as none", () => {
    const quality = deriveLicFixtureQuality(
      task({ licSeed: { symbol: "MissingSymbol", investigateQuery: "Issue" } }),
      fixture("Found 0 results\n\n(no output)\nNo definition found for MissingSymbol"),
    );
    expect(quality.noDefinitionResult).toBe(true);
    expect(quality.signal).toBe("none");
  });

  it("classifies ground-truth chunks as leaks", () => {
    const leakedText = "The team shipped this exact long answer chunk with a very specific payload merge and validation sequence that should not appear in lic output.";
    const quality = deriveLicFixtureQuality(
      task({ groundTruth: { output: leakedText.repeat(2) } }),
      fixture(`lic result:\n${leakedText.repeat(2)}`),
    );
    expect(quality.answerLeak).toBe(true);
    expect(quality.signal).toBe("leak");
  });

  it("classifies partial but non-primary results as weak", () => {
    const quality = deriveLicFixtureQuality(
      task(),
      fixture("Found 5 results\n\n1. web-src/src/other/File.ts (lines 1-20)\nSome unrelated code."),
    );
    expect(quality.primaryFileRetrieved).toBe(false);
    expect(quality.signal).toBe("weak");
  });

  it("classifies primary-file structural evidence as strong", () => {
    const quality = deriveLicFixtureQuality(
      task({ groundTruth: { output: "diff --git a/web-src/src/forms/EventForm.tsx b/web-src/src/forms/EventForm.tsx\n+++ b/web-src/src/forms/EventForm.tsx" } }),
      fixture("## symbol `saveEvent`\n**File:** `web-src/src/forms/EventForm.tsx`\n### Top Callers\n- EventForm"),
    );
    expect(quality.primaryFileRetrieved).toBe(true);
    expect(quality.signal).toBe("strong");
  });

  it("credits task-contract evidence for future KG-derived helpers", () => {
    const quality = deriveLicFixtureQuality(
      task({
        tags: ["future-emc", "kg-derived"],
        licSeed: { symbol: "getSemanticHTML", investigateQuery: "Quill rich text semantic HTML NBSP" },
        expectedSignals: ["getSemanticHTML", "NBSP", "innerHTML"],
        kgExpectations: { requiredSymbols: ["getSemanticHTML"] },
        groundTruth: undefined,
      }),
      fixture("Found 2 results\n\n**File:** `web-src/src/components/shared/RichTextEditor.tsx`\nFQN: getSemanticHTML\n### References\n- getSemanticHTML normalizes NBSP variants in editor output"),
    );
    expect(quality.primaryFileRetrieved).toBe(false);
    expect(quality.taskContractEvidenceRetrieved).toBe(true);
    expect(quality.signal).toBe("strong");
    expect(isLicFixtureQualityReady(quality)).toBe(true);
  });

  it("does not consider weak fixtures ready for protocol runs", () => {
    const quality = deriveLicFixtureQuality(
      task(),
      fixture("Found 5 results\n\n1. web-src/src/other/File.ts (lines 1-20)\nSome unrelated code."),
    );
    expect(quality.signal).toBe("weak");
    expect(isLicFixtureQualityReady(quality)).toBe(false);
    expect(describeLicFixtureQualityGate("task", quality)).toContain("medium/strong");
  });
});

describe("LIC oracle helpers", () => {
  it("extracts files from unified diffs", () => {
    expect(extractGroundTruthFiles([
      "diff --git a/web-src/src/forms/EventForm.tsx b/web-src/src/forms/EventForm.tsx",
      "--- a/web-src/src/forms/EventForm.tsx",
      "+++ b/web-src/src/forms/EventForm.tsx",
      "diff --git a/web-src/src/new/File.ts b/web-src/src/new/File.ts",
      "--- /dev/null",
      "+++ b/web-src/src/new/File.ts",
    ].join("\n"))).toEqual([
      "web-src/src/forms/EventForm.tsx",
      "web-src/src/new/File.ts",
    ]);
  });

  it("extracts answer symbols after subtracting allowed prompt, seed, file, and expected symbols", () => {
    const t = task({
      prompt: "Fix allowedPromptSymbol in the event form.",
      licSeed: { symbol: "allowedSeedSymbol", investigateQuery: "allowedQuerySymbol behavior" },
      expectedSignals: ["allowedExpectedSignal"],
      groundTruth: {
        output: [
          "diff --git a/web-src/src/forms/EventForm.tsx b/web-src/src/forms/EventForm.tsx",
          "+++ b/web-src/src/forms/EventForm.tsx",
          "@@",
          "+const newMergedAnswerSymbol = allowedPromptSymbol + allowedSeedSymbol + allowedQuerySymbol + allowedExpectedSignal + EventForm;",
        ].join("\n"),
      },
    });

    const extracted = extractGroundTruthSymbols(t, "newMergedAnswerSymbol appears in the rendered fixture");

    expect(extracted.symbols).toContain("newMergedAnswerSymbol");
    expect(extracted.symbols).not.toContain("allowedPromptSymbol");
    expect(extracted.symbols).not.toContain("allowedSeedSymbol");
    expect(extracted.symbols).not.toContain("allowedQuerySymbol");
    expect(extracted.symbols).not.toContain("allowedExpectedSignal");
    expect(extracted.symbols).not.toContain("EventForm");
    expect(extracted.leakedSymbols).toContain("newMergedAnswerSymbol");
  });

  it("does not treat unchanged diff context as answer symbols", () => {
    const t = task({
      groundTruth: {
        output: [
          "diff --git a/web-src/src/forms/EventForm.tsx b/web-src/src/forms/EventForm.tsx",
          "--- a/web-src/src/forms/EventForm.tsx",
          "+++ b/web-src/src/forms/EventForm.tsx",
          "@@",
          " const existingContextSymbol = buildExistingContextPayload(formState)",
          "-const removedContextSymbol = existingContextSymbol",
          "+const newMergedAnswerSymbol = existingContextSymbol + removedContextSymbol + buildPayloadForEventSave(formState)",
        ].join("\n"),
      },
    });

    const extracted = extractGroundTruthSymbols(
      t,
      "existingContextSymbol and removedContextSymbol appear in the rendered fixture",
    );

    expect(extracted.symbols).toContain("newMergedAnswerSymbol");
    expect(extracted.symbols).not.toContain("existingContextSymbol");
    expect(extracted.symbols).not.toContain("removedContextSymbol");
    expect(extracted.leakedSymbols).toEqual([]);
  });

  it("extracts contract evidence from LIC and expected signal fields", () => {
    const evidence = extractTaskContractEvidence(task({
      licSignals: ["SessionTimeInfo response"],
      expectedSignals: ["prepareContactMethodsForPut", "NBSP"],
    }));

    expect(evidence).toEqual(expect.arrayContaining(["SessionTimeInfo", "prepareContactMethodsForPut", "NBSP"]));
  });

  it("extracts long leakage chunks and likely answer symbols", () => {
    const longText = "The shipped implementation used a narrow merged payload helper with a very specific timestamp fallback sequence and field allowlist. ";

    expect(extractGroundTruthChunks(longText.repeat(2)).length).toBeGreaterThan(0);
    expect(extractIdentifiers("const mergedPayloadForSpeakerUpdate = true")).toContain("mergedPayloadForSpeakerUpdate");
    expect(isLikelyAnswerSymbol("mergedPayloadForSpeakerUpdate")).toBe(true);
  });
});
