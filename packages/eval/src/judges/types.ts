export interface JudgeResult {
  /** Pass/fail (code) or score >= threshold (content). */
  passed: boolean;
  /** 0-1. For code, 1.0 if all tests pass else 0.0. For content, weighted aggregate. */
  score: number;
  /** Short explanation. */
  detail: string;
  /** Code: list of failing test names + reasons. */
  failures?: string[];
  /** Content: per-criterion scores from the LLM judge. */
  rubricScores?: Record<string, number>;
}
