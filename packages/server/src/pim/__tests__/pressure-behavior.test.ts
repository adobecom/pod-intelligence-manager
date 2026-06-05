import { describe, it, expect } from "vitest";
import {
  contestedConflictIdsForScope,
  isCautiousPressure,
  isDegradedPressure,
} from "../pressure-behavior.js";
import { DEFAULT_ORG_TUNING } from "@pim/shared";

describe("pressure-behavior", () => {
  const thresholds = DEFAULT_ORG_TUNING.pressure;

  it("detects scope in conflict summary", () => {
    const ids = contestedConflictIdsForScope("backend", [
      {
        id: "C-1",
        summary: "backend API contract clash",
        impact_json: "[]",
        sides_json: "[]",
      },
    ]);
    expect(ids).toEqual(["C-1"]);
  });

  it("classifies cautious and degraded bands", () => {
    expect(isCautiousPressure(0.45, thresholds)).toBe(true);
    expect(isDegradedPressure(0.7, thresholds)).toBe(true);
    expect(isDegradedPressure(0.85, thresholds)).toBe(false);
  });
});
