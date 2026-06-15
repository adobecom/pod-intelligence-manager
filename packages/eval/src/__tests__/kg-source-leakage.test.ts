import { describe, expect, it } from "vitest";
import {
  formatKgLeakageFindings,
  hasKgLeakageErrors,
  isClaimableKgSourcePath,
  validateKgCandidatePayload,
  validateKgSourceFiles,
  validateKgSourceManifestObject,
} from "../rigor/kg-source-leakage.js";

describe("KG source leakage policy", () => {
  it("allows product source paths and rejects eval artifacts", () => {
    expect(isClaimableKgSourcePath("packages/server/src/services/knowledge-graph.ts")).toBe(true);
    expect(isClaimableKgSourcePath("packages/eval/src/tasks/primary/kg-future/index.ts")).toBe(false);

    const findings = validateKgSourceFiles([
      "packages/server/src/services/knowledge-graph.ts",
      "packages/eval/runs/kg-future-haiku-1seed-rerun-3/manifest.json",
      "packages/eval/fixtures/lic/future-emc-prod-publish-confirmation.json",
    ]);

    expect(hasKgLeakageErrors(findings)).toBe(true);
    expect(formatKgLeakageFindings(findings)).toContain("kg-source-denied-path");
  });

  it("flags source files outside the claimable allowlist as warnings", () => {
    const findings = validateKgSourceFiles(["docs/product-note.md"]);

    expect(hasKgLeakageErrors(findings)).toBe(false);
    expect(findings).toEqual([
      expect.objectContaining({
        severity: "warning",
        code: "kg-source-outside-allowlist",
      }),
    ]);
  });

  it("rejects candidate text that names eval task artifacts", () => {
    const findings = validateKgCandidatePayload({
      source_label: "local/packages/eval/src/tasks/primary/kg-future/index.ts",
      summary: "Fix future-emc-prod-publish-confirmation by returning show_confirmation",
      details: "The kg-future expected answer should pass.",
    });

    expect(hasKgLeakageErrors(findings)).toBe(true);
    expect(findings.map((finding) => finding.token)).toEqual(
      expect.arrayContaining(["future-emc-", "kg-future", "show_confirmation"]),
    );
  });

  it("validates a source manifest with the same policy", () => {
    const findings = validateKgSourceManifestObject({
      kind: "kg-source-manifest",
      claimability: "claimable",
      files: [
        { path: "packages/shared/src/index.ts" },
        { path: "packages/eval/src/tasks/task-sets.ts" },
      ],
    });

    expect(hasKgLeakageErrors(findings)).toBe(true);
    expect(findings).toEqual([
      expect.objectContaining({ severity: "error", code: "kg-source-denied-path" }),
    ]);
  });
});
