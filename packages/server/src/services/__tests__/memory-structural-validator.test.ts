import { describe, expect, it } from "vitest";
import {
  MemoryStructuralValidationError,
  assertMemoryStructure,
  memoryStructuralIssues,
  normalizeRepositoryId,
} from "../memory-structural-validator.js";

const content = {
  summary: "Retries must retain one stable idempotency key.",
  details: "Every provider retry for a logical payment must reuse the first idempotency key.",
  rationale: "A new key can create a second charge after an ambiguous timeout.",
};

describe("shared memory structural validator", () => {
  it("accepts a structurally complete codebase constraint", () => {
    expect(() => assertMemoryStructure({
      plane: "codebase",
      kind: "constraint",
      content,
      applicability: { repository_id: "github.com/acme/checkout", paths: ["src/retry.ts"] },
      validation: { strategy: "repository_anchors" },
      exceptions: [],
    })).not.toThrow();
  });

  it("enforces discriminated applicability instead of substituting harness selectors", () => {
    const issues = memoryStructuralIssues({
      plane: "codebase",
      kind: "constraint",
      content,
      applicability: { harness_id: "fiesta", harness_version_range: "*" },
      validation: { strategy: "repository_anchors" },
      exceptions: [],
    });
    expect(issues).toContainEqual({
      path: "/applicability",
      reason: "codebase memory requires codebase applicability",
    });
  });

  it("requires anti-pattern bounds and a stable failure fingerprint", () => {
    expect(() => assertMemoryStructure({
      plane: "codebase",
      kind: "anti_pattern",
      content,
      applicability: { repository_id: "github.com/acme/checkout", paths: ["src/retry.ts"] },
      validation: { strategy: "repository_anchors" },
      exceptions: [],
    })).toThrow(MemoryStructuralValidationError);
  });

  it("canonicalizes only exact GitHub repository identifiers", () => {
    expect(normalizeRepositoryId(" GitHub.com/Acme/Checkout/ ")).toBe("github.com/acme/checkout");
    expect(normalizeRepositoryId("/workspaces/acme/checkout")).toBeNull();
    expect(normalizeRepositoryId("checkout")).toBeNull();
  });
});

