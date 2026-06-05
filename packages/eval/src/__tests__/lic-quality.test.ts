import { describe, expect, it } from "vitest";
import type { LicContextFixture } from "../arms/types.js";
import { deriveLicFixtureQuality } from "../rigor/lic-quality.js";
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
});
