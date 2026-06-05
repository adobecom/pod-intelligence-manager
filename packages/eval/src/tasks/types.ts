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

/** PIM-vs-lic protocol strata. S7 = content-gen, S6 = archaeology (both excluded from the headline). */
export type Stratum = "S1" | "S2" | "S3" | "S4" | "S5" | "S6" | "S7";

/**
 * Prompt realism tier (orthogonal to stratum). The headline claim uses only
 * `realistic-ticket`; the others are reported separately.
 * - `saturated`: issue + exact implementation checklist / pasted source (sanity check).
 * - `realistic-ticket`: ticket/issue text + at most one starting-file hint (headline).
 * - `underspecified`: vague symptom or outcome only.
 * - `context-required`: deliberately omits an org convention / prior decision.
 */
export type PromptTier = "saturated" | "realistic-ticket" | "underspecified" | "context-required";

/** Seed `lic-freeze` uses to retrieve a task's lic fixture: a symbol and/or NL query. */
export interface LicSeed {
  symbol?: string;
  investigateQuery?: string;
}

/** Provenance of a real-PR-derived task; consumed by the lic freezer and rigor audits. */
export interface TaskProvenance {
  /** Merge commit SHA of the source PR. */
  mergeSha?: string;
  /** Parent (pre-merge) SHA — S2 worktree-per-asOf indexing needs this. */
  parentSha?: string;
  /** URL of the source PR or issue. */
  sourceUrl?: string;
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
  /**
   * Stratification metadata for the PIM-vs-lic protocol (see tasks/stratification.ts).
   * Most real-emc tasks get `stratum`/`licSeed` from the assignments map; S5/S6
   * tasks declare `stratum` inline. `excluded` drops saturated/no-signal tasks.
   */
  stratum?: Stratum;
  excluded?: boolean;
  /**
   * Prompt realism tier. When unset, `classifyPromptTier` derives it from the
   * tier map / tags. The headline claim is restricted to `realistic-ticket`.
   */
  promptTier?: PromptTier;
  /** Seed used by `lic-freeze` to retrieve this task's lic fixture. */
  licSeed?: LicSeed;
  /** Provenance of a real-PR-derived task. */
  provenance?: TaskProvenance;
  /**
   * Point-in-time anchor (ISO timestamp). When set, time-aware arms can restrict
   * PIM context to on/before this instant to avoid temporal leakage.
   */
  asOf?: string;
}
