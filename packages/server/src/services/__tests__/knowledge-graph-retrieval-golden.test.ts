import { describe, expect, it, vi } from "vitest";

vi.mock("../graph-storage.js", () => ({
  loadGraph: vi.fn(() => null),
  saveGraph: vi.fn(),
}));

vi.mock("../org-settings.js", async () => {
  const { DEFAULT_ORG_TUNING } = await import("@pim/shared");
  return {
    getOrgTuning: vi.fn(() => DEFAULT_ORG_TUNING),
  };
});

import oracleJson from "../__fixtures__/kg-retrieval-oracle.json";
import {
  evaluateRetrievalOracle,
  formatRetrievalEvalFailures,
  STRICT_GATE_BUDGET,
  validateRetrievalOracle,
  type RetrievalOracleFixture,
} from "../kg-retrieval-eval.js";

const oracle = oracleJson as RetrievalOracleFixture;

describe("knowledge graph retrieval golden oracle", () => {
  it("has an internally consistent v2 frozen graph and reviewed labels", () => {
    expect(validateRetrievalOracle(oracle)).toEqual([]);
  });

  it("passes strict recall, rank, negative-control, and forbidden-node gates", () => {
    const report = evaluateRetrievalOracle(oracle);
    expect(report.budgets).toContain(STRICT_GATE_BUDGET);
    expect(report.failures, formatRetrievalEvalFailures(report)).toEqual([]);
  });
});
