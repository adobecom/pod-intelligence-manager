import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { Task } from "../tasks/types.js";
import { ALL_TASKS } from "../tasks/index.js";
import { KG_FUTURE_20_TASK_IDS, KG_LIC_FAVORABLE_TASK_IDS, PRIMARY_15_TASK_IDS } from "../tasks/task-sets.js";
import { applyAssignmentsToAll } from "../tasks/stratification.js";
import {
  aggregateLicRetrievalCases,
  buildLicRetrievalOracleCase,
  evaluateLicRetrievalFixtures,
  loadLicRetrievalFixtures,
  scoreLicRetrievalCase,
  type LicRetrievalFixture,
} from "../rigor/lic-retrieval-eval.js";

function futureTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "future-test",
    type: "code",
    podId: "pod",
    prompt: "Implement the future helper.",
    stratum: "S3",
    tags: ["future-emc", "kg-derived"],
    kgExpectations: { requiredSymbols: ["NeededSymbol"] },
    expectedSignals: ["contractToken"],
    licSignals: ["LicOnlySignal"],
    ...overrides,
  };
}

function fixture(overrides: Partial<LicRetrievalFixture> = {}): LicRetrievalFixture {
  return {
    taskId: "future-test",
    renderedBlock: "",
    indexSource: { kind: "head", repo: "/repo" },
    calls: [],
    ...overrides,
  };
}

describe("LIC retrieval eval", () => {
  it("uses reviewed KG required symbols for future tasks", () => {
    const oracle = buildLicRetrievalOracleCase(futureTask({
      kgExpectations: { requiredSymbols: ["getSemanticHTML", "NBSP"] },
      expectedSignals: ["innerHTML"],
    }));

    expect(oracle.requiredSymbols).toEqual(["getSemanticHTML", "NBSP"]);
    expect(oracle.contractEvidence).toEqual(expect.arrayContaining(["innerHTML", "LicOnlySignal"]));
  });

  it("scores raw output separately from rendered context", () => {
    const testCase = scoreLicRetrievalCase(
      futureTask(),
      fixture({
        calls: [{ output: "src/Future.ts\nNeededSymbol\ncontractToken\nLicOnlySignal" }],
        renderedBlock: "src/Future.ts\ncontractToken",
      }),
    );

    expect(testCase.rawOutput.symbols.recall).toBe(1);
    expect(testCase.rawOutput.contractEvidence.recall).toBe(1);
    expect(testCase.renderedBlock.symbols.recall).toBe(0);
    expect(testCase.renderedBlock.contractEvidence.recall).toBe(0.5);
  });

  it("aggregates item recall across cases", () => {
    const one = scoreLicRetrievalCase(
      futureTask({ id: "one", kgExpectations: { requiredSymbols: ["Alpha", "Beta"] } }),
      fixture({ taskId: "one", calls: [{ output: "Alpha" }], renderedBlock: "Alpha" }),
    );
    const two = scoreLicRetrievalCase(
      futureTask({ id: "two", kgExpectations: { requiredSymbols: ["Gamma"] } }),
      fixture({ taskId: "two", calls: [{ output: "Gamma" }], renderedBlock: "" }),
    );

    const report = aggregateLicRetrievalCases([one, two], { taskSet: "unit", generatedAt: "test" });

    expect(report.rawOutput.symbolHits).toBe(2);
    expect(report.rawOutput.symbolRequired).toBe(3);
    expect(report.rawOutput.symbolRecall).toBeCloseTo(2 / 3);
    expect(report.renderedBlock.symbolHits).toBe(1);
    expect(report.renderedBlock.symbolRequired).toBe(3);
  });

  it("loads frozen first-pass fixtures and reports leakage consistently with fixture quality", async () => {
    const firstPassIds = new Set<string>([
      ...PRIMARY_15_TASK_IDS,
      ...KG_FUTURE_20_TASK_IDS,
      ...KG_LIC_FAVORABLE_TASK_IDS,
    ]);
    const assigned = applyAssignmentsToAll(ALL_TASKS).filter((task) => firstPassIds.has(task.id));
    const fixturesDir = fileURLToPath(new URL("../../fixtures/lic", import.meta.url));
    const fixtures = await loadLicRetrievalFixtures(fixturesDir, assigned.map((task) => task.id));
    const report = evaluateLicRetrievalFixtures(assigned, fixtures, { taskSet: "first-pass", generatedAt: "test" });

    const casesById = new Map(report.cases.map((testCase) => [testCase.taskId, testCase]));
    const leakageFindings = report.claimBlockingFindings.filter((finding) => finding.kind === "answer_leak");

    expect(report.missingFixtures).toBe(0);
    expect(leakageFindings.every((finding) => casesById.get(finding.taskId)?.quality?.signal === "leak")).toBe(true);
  });
});
