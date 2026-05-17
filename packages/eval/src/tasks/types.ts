export type TaskType = "code" | "content";

export interface TestCase {
  /** Short label rendered in the report. */
  name: string;
  /**
   * Body of an async test function. Inside the body, `mod` is the agent's
   * module (default export and named exports), and `assert` is node:assert/strict.
   * Throw or call assert.* to fail the test.
   */
  body: string;
}

export type RubricScale = "0-5" | "boolean";

export interface RubricCriterion {
  id: string;
  description: string;
  scale: RubricScale;
  /** Sums across criteria don't have to equal 1; the aggregator normalizes. */
  weight: number;
}

export interface Rubric {
  id: string;
  criteria: RubricCriterion[];
}

export interface Task {
  id: string;
  type: TaskType;
  /** ID of the fixture's SessionContext to inject in the treatment arm. */
  podId: string;
  /** The user-facing task prompt. */
  prompt: string;
  /**
   * Diagnostic — phrases or symbols that a PIM-aware answer should reference
   * (e.g., "C-101", "GroupContext"). Used in the report's diagnostic table; not part of the score.
   */
  expectedSignals?: string[];
  /** Code-gen only. */
  tests?: TestCase[];
  /**
   * Code-gen only. Optional helper appended before the agent's code in the
   * sandboxed test file (e.g., type stubs, fetch mock).
   */
  testHarness?: string;
  /** Content-gen only. */
  rubric?: Rubric;
  /**
   * Optional reference output (e.g., the merged patch on a real-PR task).
   * When present, ground-truth-aware judges include it as reference material
   * so the model is scored against what the team actually shipped.
   */
  groundTruth?: {
    /** The reference output. For real-PR tasks this is the merged diff (unified format). */
    output: string;
    /** Where this came from: repo + PR # + merge SHA, or any provenance note. */
    note?: string;
  };
  /** Tag tasks for filtering: e.g., "smoke", "rbac". */
  tags?: string[];
}
