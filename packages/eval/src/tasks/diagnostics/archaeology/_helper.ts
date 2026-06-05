import type { Rubric } from "../../types.js";

/**
 * Shared rubric for S6 code-archaeology content tasks.
 *
 * The judge scores three things:
 *   1. Recall: did the agent name the expected files/symbols?
 *   2. Accuracy: did the agent avoid inventing files or callers that don't exist?
 *   3. Format: did the agent produce a parseable markdown list with file paths?
 *
 * Ground truth is captured by running lic against EMC at HEAD; the rubric is
 * checked by the LLM judge which sees the ground-truth list. Lexical match is
 * not required — semantic equivalence is acceptable (judge instruction).
 */
export function archaeologyRubric(rubricId: string): Rubric {
  return {
    id: rubricId,
    criteria: [
      {
        id: "recall",
        description:
          "Did the agent name at least 70% of the expected files / symbols from the ground-truth list? Count matches by file path; allow line-range to differ. Score 0-5 where 5 = >= 90% recall, 4 = 70-89%, 3 = 50-69%, 2 = 30-49%, 1 = 1-29%, 0 = none.",
        scale: "0-5",
        weight: 3,
      },
      {
        id: "accuracy",
        description:
          "Did the agent avoid inventing files or callsites that don't exist in the ground truth? Count fabricated file paths or wildly-wrong line ranges. Score 0-5: 5 = no fabrications, 4 = 1 minor (typo'd path), 3 = 1-2 fabrications, 2 = 3 fabrications, 1 = >3 fabrications, 0 = mostly invented.",
        scale: "0-5",
        weight: 3,
      },
      {
        id: "format",
        description:
          "Is the output a clean markdown list of file paths (with optional line ranges and one-sentence reasons), parseable without prose interleaved? Boolean.",
        scale: "boolean",
        weight: 1,
      },
      {
        id: "no_misclassification",
        description:
          "If the task asks for 'write sites' or 'callers' specifically, did the agent avoid listing read-only references or definitions? Boolean (true = on-topic, false = mixed in off-topic refs).",
        scale: "boolean",
        weight: 1,
      },
    ],
  };
}
